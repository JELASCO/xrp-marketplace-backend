const xrpl = require('xrpl');

class XRPLClient {
  constructor() {
    this.client = null;
    this._connecting = false;
  }

  async get() {
    if (this.client?.isConnected()) return this.client;
    if (this._connecting) {
      await new Promise(r => setTimeout(r, 300));
      return this.get();
    }
    this._connecting = true;
    try {
      this.client = new xrpl.Client(process.env.XRPL_NODE || 'wss://xrplcluster.com');
      this.client.on('disconnected', () => {
        console.warn('[XRPL] Disconnected — will reconnect on next call');
        this.client = null;
        this._connecting = false;
      });
      await this.client.connect();
      console.log(`[XRPL] Connected → ${process.env.XRPL_NODE}`);
      this._connecting = false;
      return this.client;
    } catch (e) {
      this._connecting = false;
      throw e;
    }
  }

  async disconnect() {
    if (this.client?.isConnected()) await this.client.disconnect();
    this.client = null;
  }
}

module.exports = new XRPLClient();
