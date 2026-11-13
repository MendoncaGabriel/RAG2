// Mede de novo, neste PC, quantas threads deixam o Ollama mais rápido com o modelo de chat ativo (ignora o ajuste salvo em data/tuning.json).
// Uso: npm run tune   (o servidor faz o mesmo sozinho na 1ª inicialização de cada PC/modelo)
import "dotenv/config";
const { tuneTarget } = await import("../src/rag.js");
const { autoTune } = await import("../src/tuning.js");
const result = await autoTune(await tuneTarget(), { force: true });
if (result) console.table(result.samples);
process.exit(0);
