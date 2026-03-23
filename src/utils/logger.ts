/**
 * src/utils/logger.ts
 * Winston-based logger writing to console + daily rotating file.
 */

import winston from 'winston';
import path from 'path';
import { LOG_LEVEL } from '../../config.js';

const logDir = 'logs';
const date = new Date().toISOString().split('T')[0];

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Console — human-readable
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} ${level}: ${message}${metaStr}`;
        })
      ),
    }),
    // File — JSON
    new winston.transports.File({
      filename: path.join(logDir, `bot-${date}.log`),
      format: winston.format.json(),
    }),
  ],
});
