import { formatTime } from '@yuants/data-model';
import { nativeSubjectToSubject, subjectToNativeSubject } from '@yuants/utils';
import { catchError, defer, from, interval, of, Subject, takeUntil, tap, timeout } from 'rxjs';
import { IServiceInfoServerSide } from './model';
import { ITerminalMessage, PromRegistry } from './services';
import { Terminal } from './terminal';

// 1. Initialize: create a RequestContext
// 2. Routing: binding a ServiceContext to RequestContext, if complete goto pending, if error, goto finalizing
// 3. Pending: if the processing is full (auto keepalive heartbeat when pending), if failed, goto finalizing
// 4. Processing: (must be routed), if complete, go processed; if error, goto finalize
// 5. Processed: if complete, goto finalizing. release the processing, schedule the next pending request in the same service
// 6. Finalizing: complete (close) the output$ of RequestContext
// All Initialized requests must be finalizing

interface IRequestContext {
  message: ITerminalMessage;
  output$: Subject<IServiceOutput>;
  serviceContext?: IServiceContext;

  // timestamp
  initilized_at: number;
  routed_at: number;
  processing_at: number;
  processed_at: number;
  finalized_at: number;

  // response code
  response?: ITerminalMessage['res'];
}
type IServiceOutput = Omit<
  ITerminalMessage,
  'trace_id' | 'method' | 'source_terminal_id' | 'target_terminal_id'
>;

interface IServiceContext {
  service_id: string;
  method: string;
  service: IServiceInfoServerSide;
  pending: IRequestContext[];
  processing: Set<IRequestContext>;

  concurrency: number;
  capacity: number;

  // counts
  total_routed: number;
  total_processed: number;
}

/**
 * Terminal Server
 *
 * @internal
 */
export class TerminalServer {
  constructor(public readonly terminal: Terminal) {
    //
    this._setupServer();
    this._setupHeartbeat();
  }
  private _terminalOutput$ = nativeSubjectToSubject(this.terminal.output$);

  public mapServiceIdToService = new Map<string, IServiceInfoServerSide>();

  private _mapServiceIdToServiceRuntimeContext = new Map<string, IServiceContext>();

  private _mapMethodToServiceIds = new Map<string, Set<string>>();

  addService = (service: IServiceInfoServerSide) => {
    const serviceId = service.serviceInfo.service_id || service.serviceInfo.method;
    this.mapServiceIdToService.set(serviceId, service);
    this._mapMethodToServiceIds.set(
      service.serviceInfo.method,
      (this._mapMethodToServiceIds.get(service.serviceInfo.method) || new Set()).add(serviceId),
    );
    this._mapServiceIdToServiceRuntimeContext.set(serviceId, {
      service_id: serviceId,
      method: service.serviceInfo.method,
      service: this.mapServiceIdToService.get(serviceId)!,
      pending: [],
      processing: new Set(),

      concurrency: service.options.concurrent || Infinity,
      capacity: service.options.max_pending_requests || Infinity,

      total_routed: 0,
      total_processed: 0,
    });
  };

  removeService = (serviceId: string) => {
    const service = this.mapServiceIdToService.get(serviceId);
    if (!service) return;
    this.mapServiceIdToService.delete(serviceId);
    this._mapMethodToServiceIds.get(service.serviceInfo.method)?.delete(serviceId);
  };

  // Events
  private _requestInitialized$ = new Subject<IRequestContext>();
  private _requestRouted$ = new Subject<IRequestContext>();
  private _requestPending$ = new Subject<IRequestContext>();
  private _requestProcessing$ = new Subject<IRequestContext>();
  private _requestProcessed$ = new Subject<IRequestContext>();
  private _requestFinalizing$ = new Subject<IRequestContext>();

  private _setupServer() {
    // Msg -> Initialize Request
    from(this.terminal.input$)
      .pipe(takeUntil(this.terminal.dispose$))
      .subscribe((msg) => {
        // if incoming msg is a request
        if (!msg.method) return;
        if (!msg.req) return;
        if (msg.frame || msg.res) return;

        const output$ = new Subject<IServiceOutput>();

        output$.subscribe((x) => {
          // Auto fill the trace_id and method
          this._terminalOutput$.next({
            ...x,
            trace_id: msg.trace_id,
            method: msg.method,
            // ISSUE: Reverse source / target as response, otherwise the host cannot guarantee the forwarding direction
            source_terminal_id: this.terminal.terminal_id,
            target_terminal_id: msg.source_terminal_id,
          });
        });

        const requestContext: IRequestContext = {
          message: msg,
          output$,
          initilized_at: NaN,
          routed_at: NaN,
          processing_at: NaN,
          processed_at: NaN,
          finalized_at: NaN,
        };

        output$.subscribe((x) => {
          if (x.res) {
            requestContext.response = x.res;
          }
        });

        this._requestInitialized$.next(requestContext);
      });

    // Service Routing: Request Initialized -> Request Routed / Request Finalized
    this._requestInitialized$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      requestContext.initilized_at = Date.now();
      RequestReceivedTotal.inc({
        method: requestContext.message.method!,
        source_terminal_id: requestContext.message.source_terminal_id,
        target_terminal_id: this.terminal.terminal_id,
      });

      const { message, output$ } = requestContext;
      const method = message.method!;
      // find the service
      const candidates = this._mapMethodToServiceIds.get(method);
      if (!candidates) {
        output$.next({ res: { code: 400, message: 'Bad Request: Method Not Found' } });
        this._requestFinalizing$.next(requestContext);
        return;
      }
      let targetService: IServiceInfoServerSide | undefined;
      for (const serviceId of candidates) {
        const serviceInfo = this.mapServiceIdToService.get(serviceId);
        if (!serviceInfo) continue;
        if (serviceInfo.validator(message.req!)) {
          if (targetService) {
            output$.next({ res: { code: 400, message: 'Bad Request: Ambiguous Service' } });
            this._requestFinalizing$.next(requestContext);
            return;
          }
          targetService = serviceInfo;
        }
      }
      if (!targetService) {
        output$.next({ res: { code: 400, message: 'Bad Request: No Matching Service' } });
        this._requestFinalizing$.next(requestContext);
        return;
      }

      // Routing Finished, Binding ServiceContext to RequestContext
      const serviceId = targetService.serviceInfo.service_id || targetService.serviceInfo.method;
      const serviceContext = this._mapServiceIdToServiceRuntimeContext.get(serviceId);
      if (!serviceContext) {
        output$.next({ res: { code: 500, message: 'Internal Server Error: Service Not Found' } });
        this._requestFinalizing$.next(requestContext);
        return;
      }
      requestContext.serviceContext = serviceContext;
      this._requestRouted$.next(requestContext);
    });

    // Add Pending: Request Routed -> Request Pending / Request Finalizing
    this._requestRouted$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      requestContext.routed_at = Date.now();
      const { serviceContext, output$ } = requestContext;
      if (!serviceContext) throw new Error('ServiceContext Not Found');

      serviceContext.total_routed++;

      if (serviceContext.pending.length >= serviceContext.capacity) {
        output$.next({ res: { code: 503, message: 'Service Unavailable' } });
        this._requestFinalizing$.next(requestContext);
        return;
      }

      this._requestPending$.next(requestContext);
    });

    // Waiting Room: Pending -> Processing
    this._requestPending$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      const { serviceContext } = requestContext;
      if (!serviceContext) throw new Error('ServiceContext Not Found');

      // if the processing is full, add to pending queue
      if (serviceContext.processing.size >= serviceContext.concurrency) {
        serviceContext.pending.push(requestContext);
        return;
      }

      // move to processing
      this._requestProcessing$.next(requestContext);
    });

    // Processing: Request Processing -> Request Processed
    this._requestProcessing$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      requestContext.processing_at = Date.now();
      const { message, serviceContext, output$ } = requestContext;
      if (!serviceContext) throw new Error('ServiceContext Not Found');
      serviceContext.processing.add(requestContext);

      // ISSUE: from -> defer, make sure the error of handler will be caught
      defer(() => serviceContext.service.handler(message, subjectToNativeSubject(output$)))
        .pipe(
          timeout({
            first: 30_000,
            each: 10_000,
            meta: `Handler Timeout: method=${message.method} target=${message.source_terminal_id}`,
          }),
          catchError((err) => {
            console.info(formatTime(Date.now()), `ServerError`, JSON.stringify(message), err);
            return of({ res: { code: 500, message: `Internal Server Error: ${err}` } });
          }),
          tap({
            next: (msg) => {
              output$.next(msg);
            },
            complete: () => {
              this._requestProcessed$.next(requestContext);
            },
          }),
        )
        .pipe(takeUntil(this.terminal.dispose$))
        .subscribe();
    });

    // Processed: Request Processed -> Finalizing, release the processing, schedule the next pending
    this._requestProcessed$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      requestContext.processed_at = Date.now();
      const { serviceContext } = requestContext;
      if (!serviceContext) throw new Error('ServiceContext Not Found');

      serviceContext.processing.delete(requestContext);
      serviceContext.total_processed++;

      // finalize
      this._requestFinalizing$.next(requestContext);

      // schedule the next pending
      if (serviceContext.pending.length > 0) {
        const nextRequest = serviceContext.pending.shift()!;
        this._requestProcessing$.next(nextRequest);
      }
    });

    // Finalizing
    this._requestFinalizing$.pipe(takeUntil(this.terminal.dispose$)).subscribe((requestContext) => {
      requestContext.finalized_at = Date.now();
      requestContext.output$.complete();

      const duration = requestContext.finalized_at - requestContext.initilized_at;
      if (isNaN(duration)) return;
      RequestDurationBucket.observe(duration, {
        method: requestContext.message.method!,
        source_terminal_id: requestContext.message.source_terminal_id,
        target_terminal_id: this.terminal.terminal_id,
        code: requestContext.response?.code ?? 520,
      });
    });
  }

  private _setupHeartbeat() {
    interval(5000)
      .pipe(takeUntil(this.terminal.dispose$))
      .subscribe(() => {
        this._mapServiceIdToServiceRuntimeContext.forEach((serviceContext) => {
          serviceContext.pending.forEach((requestContext) => {
            requestContext.output$.next({});
          });
        });
      });
  }
}

const RequestDurationBucket = PromRegistry.create(
  'histogram',
  'terminal_request_duration_milliseconds',
  'terminal_request_duration_milliseconds Request Duration bucket in 1, 10, 100, 1000, 10000 ms',
  [1, 10, 100, 1000, 10000],
);

const RequestReceivedTotal = PromRegistry.create(
  'counter',
  'terminal_request_received_total',
  'terminal_request_received_total Terminal request received',
);
