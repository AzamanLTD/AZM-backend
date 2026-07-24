/**
 * Structured logging with Pino.
 *
 * Replaces console.log / console.error / console.warn across the codebase.
 * In production: emits JSON lines (for log aggregation — Datadog, Loki, etc.).
 * In development: pretty-prints with colorized output via pino-pretty.
 *
 * Usage:
 *   const logger = require('./src/config/logger');
 *   logger.info({ userId, action: 'deposit', amount }, 'Deposit processed');
 *   logger.error({ err, userId }, 'Withdrawal failed');
 *   logger.warn({ poolName, balance, threshold }, 'Fiat pool low');
 *   logger.debug({ reqId, method, path }, 'Incoming request');
 *
 * Sensitive fields are auto-redacted: password, token, secret, otp, pin.
 */

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const logger = pino({
    level: process.env.LOG_LEVEL || (isTest ? 'silent' : (isProduction ? 'info' : 'debug')),
    redact: {
        paths: [
            'password',
            'token',
            'secret',
            'otp',
            'pin',
            '*.password',
            '*.token',
            '*.secret',
            '*.otp',
            '*.pin',
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.token',
            'req.body.otp',
            'req.body.pin',
        ],
        censor: '[REDACTED]',
    },
    transport: (!isProduction && !isTest)
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        req: (req) => ({
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
        }),
        res: (res) => ({
            statusCode: res.statusCode,
        }),
    },
});

module.exports = logger;
module.exports.logger = logger;
