import { PortalClient } from '@abernatskiy/portal-client';
import { createClient } from '@clickhouse/client';
import { ClickhouseState } from '../core/states/clickhouse_state';
import { TrackProgress } from '../core/track_progress';
import { Erc20Datasource } from '../erc20/erc20';
import { createLogger, formatNumber, last } from './utils';

async function main() {
  const portal = new PortalClient({
    url: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
  });

  /**
   * Initialize Clickhouse client
   */
  const clickhouse = createClient({
    url: 'http://localhost:8123',
    password: '',
  });

  const logger = createLogger('erc20');

  /**
   *  Current streaming progress will be stored in the 'status_erc20' Clickhouse table.
   *  The table will be created if it does not exist.
   *  If the table already exists, the last processed block will be read from it,
   *  thus allowing the process to continue from the last block.
   */
  const state = new ClickhouseState(clickhouse, {
    table: 'status_erc20',
  });

  /**
   * Initialize Erc20 datasource with the following parameters:
   */
  const ds = new Erc20Datasource({
    portal,
    args: {
      fromBlock: 4634748,
      contracts: ['0xdac17f958d2ee523a2206206994597c13d831ec7'],
    },
    logger,
    state,
  });

  /**
   * Create the 'erc20_transfers' table in Clickhouse if it does not exist.
   */
  await clickhouse.command({
    query: ` 
      CREATE TABLE IF NOT EXISTS erc20_transfers
      (block_number UInt32, from String, to String, token LowCardinality(String), amount Int64, timestamp DateTime, tx String)
      ENGINE = MergeTree()
      ORDER BY (timestamp, token)
    `,
  });

  /**
   * Track the progress of the streaming process.
   * It will simply log the current block number, the head block number, and the speed of the process every 5 seconds.
   */
  const progress = new TrackProgress({
    portal,
    intervalSeconds: 5,
    onProgress: ({blocks, interval}) => {
      logger.info({
        message: `${formatNumber(blocks.current)} / ${formatNumber(blocks.head)} (${formatNumber(blocks.percent_done)}%)`,
        speed: interval.speed,
      });
    },
  });

  for await (const erc20 of await ds.stream()) {
    /**
     *   We recommend using transactions for inserts to ensure data consistency,
     *   though it is an experimental Clickhouse feature.
     *
     *    https://clickhouse.com/docs/en/guides/developer/transactional#transactions-commit-and-rollback
     */
    // await clickhouse.command({query: 'BEGIN TRANSACTION'});

    await clickhouse.insert({
      table: 'erc20_transfers',
      values: erc20.map((e) => ({
        token: e.token_address,
        from: e.from,
        to: e.to,
        amount: e.amount.toString(),
        block_number: e.block.number,
        tx: e.tx,
        timestamp: Math.round(e.timestamp.getTime() / 1000),
      })),
      format: 'JSONEachRow',
    });

    const block = last(erc20).block;

    /**
     * Store the last processed block in the Clickhouse table 'status_erc20'.
     */
    await state.set(block);

    /**
     * Notify the progress tracker about the last processed block.
     */
    progress.track(block);

    logger.debug(`processed ${erc20.length} erc20 transfers`);

    // await clickhouse.command({query: 'COMMIT'});
  }
}

void main();
