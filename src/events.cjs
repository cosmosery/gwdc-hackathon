const { EventEmitter } = require('node:events');

class BatchEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  emitBatchEvent(batchId, message) {
    this.emit(`batch:${batchId}`, message);
  }

  subscribe(batchId, res) {
    const channel = `batch:${batchId}`;
    const listener = (msg) => {
      try {
        res.raw.write(`data: ${msg}\n\n`);
      } catch (err) {
        // connection closed
      }
    };

    this.on(channel, listener);

    // Initial ping/connection established
    res.raw.write(`: connected\n\n`);

    res.raw.on('close', () => {
      this.off(channel, listener);
    });
  }
}

const eventEmitter = new BatchEventEmitter();

module.exports = { eventEmitter };
