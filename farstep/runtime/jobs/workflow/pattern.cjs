const { parentPort, workerData } = require("node:worker_threads");
const pattern = new RegExp(workerData);
parentPort.on("message", (log) => parentPort.postMessage(pattern.test(log)));
