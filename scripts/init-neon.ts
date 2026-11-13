import 'dotenv/config';
import process from 'node:process';
import { initializeDatabaseControlled } from '../src/server/modules/dbInit.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';

async function main() {
  const result = await runWithRuntimeContext(
    { env: process.env, isWorker: false },
    () => initializeDatabaseControlled({ actorUserId: 'cli_db_init', forceSchemaSync: true })
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error en inicialización controlada:', err instanceof Error ? err.message : err);
  process.exit(1);
});
