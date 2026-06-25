import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { matchesRouter } from './routes/matches.js';
import { feedRouter } from './routes/feed.js';
import { courtsRouter } from './routes/courts.js';
import { territoriesRouter } from './routes/territories.js';
import { notificationsRouter } from './routes/notifications.js';
import { errorHandler, notFound } from './middleware/error.js';

/** Build the configured Express application (no listener attached). */
export function createApp(): express.Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.cors.origin === '*' ? true : config.cors.origin.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (config.env !== 'test') app.use(morgan('dev'));

  app.get('/health', (_req, res) => res.json({ status: 'ok', env: config.env }));

  app.get('/', (_req, res) =>
    res.json({
      name: 'Vollo API',
      description: 'Tennis analytics & geospatial territorial domination engine',
      version: '0.1.0',
      endpoints: [
        'POST /api/auth/register',
        'POST /api/auth/login',
        'GET  /api/auth/me',
        'GET  /api/feed?scope=global|following',
        'POST /api/matches',
        'GET  /api/courts?lat=&lng=&radius_km=',
        'GET  /api/courts/:id/leaderboard',
        'GET  /api/territories?min_lng=&min_lat=&max_lng=&max_lat=',
        'GET  /api/users/:username/analytics',
      ],
    }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/matches', matchesRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/courts', courtsRouter);
  app.use('/api/territories', territoriesRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
