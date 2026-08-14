import { bootRuntime } from "./boot.js";

const started = bootRuntime();
if (!started.ok) {
  process.stderr.write(`${started.error.message}\n`);
  process.exitCode = 1;
} else {
  started.value.logger.info("hawaldar runtime ready");
}
