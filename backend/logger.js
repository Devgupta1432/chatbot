const LEVELS = { INFO: "INFO", WARN: "WARN", ERROR: "ERROR" };

function format(level, message, meta) {
  const ts   = new Date().toISOString();
  const base = `[${ts}] [${level}] ${message}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

const logger = {
  info:  (msg, meta) => console.log(format(LEVELS.INFO,  msg, meta)),
  warn:  (msg, meta) => console.warn(format(LEVELS.WARN,  msg, meta)),
  error: (msg, meta) => console.error(format(LEVELS.ERROR, msg, meta)),
};

module.exports = logger;
