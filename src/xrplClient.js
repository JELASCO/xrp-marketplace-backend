const xrpl = require('xrpl');

class XRPLClient {
  constructor() { this.client = null; this._connecting = false; }

  async get() {
    if (this.client?.isConnected()) return this.client;
    if (this._connecting) {
      await new Promise(r => setTimeout(r, 300));
      return this.get();
    }
    this._connecting = true;
    try {
      this.client = new xrpl.Client(process.env.XRPL_NODE || 'wss://s.altnet.rippletest.net:51233');
      this.client.on('disconnected', () => { this.client = null; this._connecting = false; });
      await this.client.connect();
      this._connecting = false;
      return this.client;
    } catch(e) {
      this._connecting = false;
      throw e;
    }
  }
}

module.exports = new XRPLClient();
