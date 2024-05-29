import { IconBolt } from '@douyinfe/semi-icons';
import { Toast } from '@douyinfe/semi-ui';
import { createColumnHelper } from '@tanstack/react-table';
import { ITransferOrder, UUID, formatTime } from '@yuants/data-model';
import { IDataRecord } from '@yuants/protocol';
import { firstValueFrom, lastValueFrom, tap } from 'rxjs';
import { InlineAccountId } from '../AccountInfo';
import { DataRecordView } from '../DataRecord';
import { Button } from '../Interactive';
import { registerPage } from '../Pages';
import { terminal$ } from '../Terminals';
import { schema } from './model';

const TYPE = 'transfer_order';

const mapOriginToDataRecord = (x: ITransferOrder): IDataRecord<ITransferOrder> => {
  const id = x.order_id;
  return {
    id,
    type: TYPE,
    created_at: x.created_at,
    updated_at: x.updated_at,
    frozen_at: null,
    tags: {
      credit_account_id: x.credit_account_id,
      debit_account_id: x.debit_account_id,
      status: `${x.status}`,
    },
    origin: x,
  };
};

function newRecord(): Partial<ITransferOrder> {
  return {
    order_id: UUID(),
    created_at: Date.now(),
  };
}

function beforeUpdateTrigger(x: ITransferOrder) {
  x.updated_at = Date.now();
}

function defineColumns() {
  return () => {
    const columnHelper = createColumnHelper<IDataRecord<ITransferOrder>>();
    return [
      columnHelper.accessor('origin.order_id', {
        header: () => '订单ID',
      }),
      columnHelper.accessor('origin.created_at', {
        header: () => '创建时间',
        cell: (ctx) => formatTime(ctx.getValue() ?? ''),
      }),
      columnHelper.accessor('origin.updated_at', {
        header: () => '更新时间',
        cell: (ctx) => formatTime(ctx.getValue() ?? ''),
      }),
      columnHelper.accessor('origin.credit_account_id', {
        header: () => '贷方账户',
        cell: (ctx) => <InlineAccountId account_id={ctx.getValue()} />,
      }),
      columnHelper.accessor('origin.debit_account_id', {
        header: () => '借方账户',
        cell: (ctx) => <InlineAccountId account_id={ctx.getValue()} />,
      }),
      columnHelper.accessor('origin.expected_amount', {
        header: () => '初始金额',
      }),
      columnHelper.accessor('origin.currency', {
        header: () => '货币',
      }),
      columnHelper.accessor('origin.status', {
        header: () => '状态',
      }),
      columnHelper.accessor('origin.routing_path', {
        header: () => '转账路径',
        cell: (ctx) => {
          const value = ctx.getValue();
          if (typeof value === 'string') return value;
          if (Array.isArray(value)) {
            return (
              <ol>
                {value.map((e) => (
                  <li>
                    <InlineAccountId account_id={e.tx_account_id || ''} />
                    {` (${e.tx_address}) -> ${e.network_id} -> (${e.rx_address}) `}
                    <InlineAccountId account_id={e.rx_account_id || ''} />
                  </li>
                ))}
              </ol>
            );
          }
        },
      }),
      columnHelper.accessor('origin.current_routing_index', {
        header: () => '当前处理进度',
        cell: (ctx) => `${(ctx.getValue() || -1) + 1} / ${ctx.row.original.origin.routing_path?.length ?? 0}`,
      }),
      columnHelper.accessor('origin.current_tx_account_id', {
        header: () => '当前转账账户',
      }),
      columnHelper.accessor('origin.current_tx_state', {
        header: () => '当前转账方状态',
      }),
      columnHelper.accessor('origin.current_network_id', {
        header: () => '当前转账网络',
      }),
      columnHelper.accessor('origin.current_rx_account_id', {
        header: () => '当前收账账户',
      }),
      columnHelper.accessor('origin.current_rx_state', {
        header: () => '当前收账方状态',
      }),
      columnHelper.accessor('origin.current_amount', {
        header: () => '当前金额',
      }),
      columnHelper.accessor('origin.debit_methods', {
        header: () => '候选方式',
        cell: (ctx) => (
          <ol>
            {ctx.getValue()?.map((e) => (
              <li>{e}</li>
            ))}
          </ol>
        ),
      }),
      columnHelper.accessor('origin.credit_method', {
        header: () => '当选方式',
      }),
      columnHelper.accessor('origin.transaction_id', {
        header: () => '转账凭证号',
      }),
      columnHelper.accessor('origin.transferred_at', {
        header: () => '转账时间',
        cell: (ctx) => formatTime(ctx.getValue() ?? ''),
      }),
      columnHelper.accessor('origin.transferred_amount', {
        header: () => '转账金额',
      }),
      columnHelper.accessor('origin.received_at', {
        header: () => '到账时间',
        cell: (ctx) => formatTime(ctx.getValue() ?? ''),
      }),
      columnHelper.accessor('origin.received_amount', {
        header: () => '到账金额',
      }),
      columnHelper.accessor('origin.error_message', {
        header: () => '错误信息',
      }),
    ];
  };
}

registerPage('TransferOrderList', () => {
  return (
    <DataRecordView
      TYPE={TYPE}
      schema={schema}
      columns={defineColumns()}
      extraRecordActions={({ reloadData, record }) => (
        <Button
          icon={<IconBolt />}
          onClick={async () => {
            const terminal = await firstValueFrom(terminal$);
            if (!terminal) return;
            await lastValueFrom(
              terminal.requestService('Transfer', record.origin).pipe(
                tap({
                  error: (err) => {
                    Toast.error(`通知转账失败: ${err}`);
                    console.error(err);
                  },
                }),
              ),
            );
            await reloadData();
            Toast.success(`通知转账成功`);
          }}
        >
          通知
        </Button>
      )}
      newRecord={newRecord}
      beforeUpdateTrigger={beforeUpdateTrigger}
      mapOriginToDataRecord={mapOriginToDataRecord}
    />
  );
});
