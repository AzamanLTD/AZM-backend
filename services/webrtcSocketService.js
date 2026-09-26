// services/webrtcSocketService.js
// =============================================================================
// AZAMAN — WebRTC Socket Signaling Service
//
// Handles all WebRTC signaling events relayed via Socket.IO:
//   - call_initiate: caller → callee (ringing notification)
//   - call_offer: SDP offer from caller → callee
//   - call_answer: SDP answer from callee → caller
//   - call_reject: callee declines → caller
//   - call_ice_candidate: ICE candidate exchange (both directions)
//   - call_end: either party terminates the call
//   - call_busy: callee is already in a call
//
// Architecture:
//   Signaling flows through Socket.IO rooms (user_{id}).
//   Media flows P2P via WebRTC (STUN/TURN fallback).
//   All calls are logged to CallLog for history + dispute evidence.
//
// Reference: WhatsApp (relay signaling via own servers, P2P media),
//            Telegram (E2E calls with relay fallback)
// =============================================================================

const logger = require('../src/config/logger');

class WebRTCSocketService {
  constructor(io, prisma) {
    this.io = io;
    this.prisma = prisma;

    // Track active calls: Map<callId, { callerId, calleeId, type, status, startedAt }>
    this.activeCalls = new Map();

    // Track users currently in a call: Map<userId, callId>
    this.userCallMap = new Map();
  }

  /**
   * Register all WebRTC socket event handlers on a connected socket.
   */
  register(socket, userId) {
    // ── 1. CALL INITIATE — caller starts a call ──────────────────────────
    socket.on('webrtc_call_initiate', async (data) => {
      try {
        const { calleeId, type } = data;
        if (!calleeId || !type) return;

        // Check if caller is already in a call
        if (this.userCallMap.has(userId)) {
          socket.emit('webrtc_call_error', { message: 'You are already in a call' });
          return;
        }

        // Check if callee is in a call
        if (this.userCallMap.has(parseInt(calleeId))) {
          socket.emit('webrtc_call_busy', { calleeId: parseInt(calleeId) });
          return;
        }

        // Create CallLog record
        const callLog = await this.prisma.callLog.create({
          data: {
            callerId: userId,
            calleeId: parseInt(calleeId),
            type: type.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'VOICE',
            status: 'RINGING',
          },
        });

        const callId = callLog.id;
        this.activeCalls.set(callId, {
          callerId: userId,
          calleeId: parseInt(calleeId),
          type,
          status: 'RINGING',
          startedAt: null,
        });
        this.userCallMap.set(userId, callId);
        this.userCallMap.set(parseInt(calleeId), callId);

        // Fetch caller info for the callee's incoming call UI
        const caller = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true, profilePictureUrl: true },
        });

        // Emit to callee's user room
        this.io.to(`user_${calleeId}`).emit('webrtc_incoming_call', {
          callId,
          callerId: userId,
          callerName: caller?.displayName || caller?.username || 'Unknown',
          callerAvatar: caller?.profilePictureUrl,
          type,
        });

        logger.info(`[WebRTC] Call initiated: ${callId} — user ${userId} -> ${calleeId} (${type})`);
      } catch (err) {
        logger.error({ err }, '[WebRTC] call_initiate error');
        socket.emit('webrtc_call_error', { message: 'Failed to initiate call' });
      }
    });

    // ── 2. CALL OFFER — SDP offer from caller → callee ───────────────────
    socket.on('webrtc_call_offer', (data) => {
      const { to, callId, sdp } = data;
      if (!to || !sdp) return;
      this.io.to(`user_${to}`).emit('webrtc_call_offer', {
        callId, from: userId, sdp,
      });
    });

    // ── 3. CALL ANSWER — SDP answer from callee → caller ──────────────────
    socket.on('webrtc_call_answer', async (data) => {
      const { to, callId, sdp } = data;
      if (!to || !sdp) return;

      const call = this.activeCalls.get(callId);
      if (call && call.status === 'RINGING') {
        call.status = 'ACCEPTED';
        call.startedAt = new Date();

        this.prisma.callLog.update({
          where: { id: callId },
          data: { status: 'ACCEPTED', startedAt: new Date() },
        }).catch(err => logger.error({ err }, '[WebRTC] Failed to update call log on answer'));
      }

      this.io.to(`user_${to}`).emit('webrtc_call_answer', {
        callId, from: userId, sdp,
      });
      logger.info(`[WebRTC] Call answered: ${callId}`);
    });

    // ── 4. CALL REJECT — callee declines the call ────────────────────────
    socket.on('webrtc_call_reject', async (data) => {
      const { to, callId, reason } = data;
      if (!to) return;

      const call = this.activeCalls.get(callId);
      if (call) {
        this.prisma.callLog.update({
          where: { id: callId },
          data: { status: 'REJECTED' },
        }).catch(err => logger.error({ err }, '[WebRTC] Failed to update call log on reject'));
        this._cleanupCall(callId);
      }

      this.io.to(`user_${to}`).emit('webrtc_call_rejected', {
        callId, reason: reason || 'declined',
      });
      logger.info(`[WebRTC] Call rejected: ${callId}`);
    });

    // ── 5. ICE CANDIDATE — relay ICE candidates between peers ────────────
    socket.on('webrtc_ice_candidate', (data) => {
      const { to, callId, candidate } = data;
      if (!to || !candidate) return;
      this.io.to(`user_${to}`).emit('webrtc_ice_candidate', {
        callId, from: userId, candidate,
      });
    });

    // ── 6. CALL END — either party terminates the call ──────────────────
    socket.on('webrtc_call_end', async (data) => {
      const { to, callId } = data;
      const call = this.activeCalls.get(callId);
      if (call) {
        const now = new Date();
        const duration = call.startedAt ? Math.floor((now - call.startedAt) / 1000) : 0;

        this.prisma.callLog.update({
          where: { id: callId },
          data: { status: 'ENDED', endedAt: now, durationSec: duration },
        }).catch(err => logger.error({ err }, '[WebRTC] Failed to update call log on end'));

        this._cleanupCall(callId);
      }

      if (to) {
        this.io.to(`user_${to}`).emit('webrtc_call_ended', { callId });
      }
      logger.info(`[WebRTC] Call ended: ${callId}`);
    });

    // ── 7. CALL QUALITY METRICS — sent at end of call ───────────────────
    socket.on('webrtc_call_metrics', async (data) => {
      const { callId, packetsLost, jitterMs, roundTripMs, audioBitrate, videoBitrate } = data;
      if (!callId) return;

      this.prisma.callLog.update({
        where: { id: callId },
        data: {
          packetsLost: packetsLost || 0,
          jitterMs: jitterMs || 0,
          roundTripMs: roundTripMs || 0,
          audioBitrate: audioBitrate || 0,
          videoBitrate: videoBitrate || 0,
        },
      }).catch(err => logger.error({ err }, '[WebRTC] Failed to save call metrics'));
    });

    // ── 8. MEDIA STATE — mute/unmute/video toggle notifications ────────
    socket.on('webrtc_media_state', (data) => {
      const { to, callId, audioEnabled, videoEnabled } = data;
      if (!to) return;
      this.io.to(`user_${to}`).emit('webrtc_media_state', {
        callId, from: userId, audioEnabled, videoEnabled,
      });
    });
  }

  _cleanupCall(callId) {
    const call = this.activeCalls.get(callId);
    if (call) {
      this.userCallMap.delete(call.callerId);
      this.userCallMap.delete(call.calleeId);
    }
    this.activeCalls.delete(callId);
  }

  handleDisconnect(userId) {
    const callId = this.userCallMap.get(userId);
    if (!callId) return;

    const call = this.activeCalls.get(callId);
    if (call) {
      const otherUserId = call.callerId === userId ? call.calleeId : call.callerId;
      const now = new Date();
      const duration = call.startedAt ? Math.floor((now - call.startedAt) / 1000) : 0;

      this.io.to(`user_${otherUserId}`).emit('webrtc_call_ended', { callId, reason: 'disconnect' });

      this.prisma.callLog.update({
        where: { id: callId },
        data: {
          status: call.status === 'RINGING' ? 'MISSED' : 'ENDED',
          endedAt: now,
          durationSec: duration,
        },
      }).catch(err => logger.error({ err }, '[WebRTC] Failed to update call log on disconnect'));

      this._cleanupCall(callId);
      logger.info(`[WebRTC] User ${userId} disconnected during call ${callId}`);
    }
  }
}

module.exports = WebRTCSocketService;
