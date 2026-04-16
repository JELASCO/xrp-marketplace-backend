let _io = null;

function init(server) {
  const { Server } = require('socket.io');
  _io = new Server(server, { cors: { origin: process.env.FRONTEND_URL, credentials: true } });

  _io.on('connection', (socket) => {
    socket.on('join', (userId) => { socket.join(`user:${userId}`); });
    socket.on('disconnect', () => {});
  });

  return _io;
}

function notify(userId, event, data) {
  if (_io) _io.to(`user:${userId}`).emit(event, data);
}

module.exports = { init, notify };
