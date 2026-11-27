import { pool, transaction } from "../packages/db";
import { seedAuthoritativeChinaRegions } from "../packages/core/regions-seed";

async function main() {
  const result = await transaction((db) => seedAuthoritativeChinaRegions(db, { includeTownships: true }));
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}
