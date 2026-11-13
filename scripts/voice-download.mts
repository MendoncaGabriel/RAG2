// Baixa antecipadamente os modelos do modo de voz (útil antes de levar o servidor para uma rede sem internet).
// Uso: npm run voice:download [-- faber alan]  (vozes: faber, cadu, jeff, alan, northern)
import "dotenv/config";
import { ensureAssets, VOICES, voiceDir } from "../src/voice.js";

const voices = process.argv.slice(2).filter(v => VOICES[v]);
const list = voices.length ? voices : ["faber", "alan"];
console.log(`Baixando modelos de voz (${list.join(", ")}) para ${voiceDir}…`);
await ensureAssets(list, stage => console.log(stage));
console.log("Modelos de voz prontos.");
