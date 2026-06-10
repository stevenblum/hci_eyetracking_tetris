import { describe, expect, it } from 'vitest';
import { REQUIRED_TABLES, TABLE_SCHEMAS } from '../../src/constants/schema.js';
import { SessionDataStore } from '../../src/data/SessionDataStore.js';
import { validateSessionSchema } from '../../src/data/schemaValidation.js';
import { AppLogger } from '../../src/logging/AppLogger.js';

describe('SessionDataStore schema contract', () => {
  it('creates every canonical table with current columns', () => {
    const store = new SessionDataStore({ participantId: 'p01' });

    expect(Object.keys(store.session.tables)).toEqual(REQUIRED_TABLES);
    expect(store.validate()).toEqual({ ok: true, errors: [] });
    expect(store.session.tables.gaze_samples.columns).toEqual(TABLE_SCHEMAS.gaze_samples);
  });

  it('rejects missing required tables and row width drift', () => {
    const store = new SessionDataStore();
    store.session.tables.gaze_samples.rows.push(['too-short']);

    const result = validateSessionSchema(store.session);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('gaze_samples row 0');
  });

  it('exports CSV headers in schema order', () => {
    const store = new SessionDataStore();

    const csv = store.toCsv('pieces');

    expect(csv.split('\n')[0]).toBe(TABLE_SCHEMAS.pieces.join(','));
  });

  it('persists structured diagnostics only when detailed logging is enabled', () => {
    const store = new SessionDataStore({ participantId: 'diag-pilot' });
    const logger = new AppLogger({
      store,
      enabled: false,
      level: 'trace',
      consoleEnabled: false,
    });

    logger.info('ui', 'setup', 'ignored_info', 'Info is buffered only while disabled.');
    logger.warn('ui', 'setup', 'warning', 'Warnings stay available in the live buffer.');
    expect(store.getRows('diagnostic_events')).toHaveLength(0);
    expect(logger.getBufferedEvents()).toHaveLength(1);

    logger.setEnabled(true);
    logger.setContext({ webgazerRunId: 'webgazer_1', trialId: null });
    logger.trace('calibration', 'precision', 'precision_sample', 'Sample detail.', {
      x: 10,
      y: 20,
    });

    expect(store.getRows('diagnostic_events')).toHaveLength(1);
    expect(store.getRows('diagnostic_events')[0]).toMatchObject({
      webgazer_run_id: 'webgazer_1',
      level: 'trace',
      category: 'calibration',
      phase: 'precision',
      action: 'precision_sample',
    });
    expect(JSON.parse(store.getRows('diagnostic_events')[0].data_json)).toEqual({ x: 10, y: 20 });
    expect(store.toCsv('diagnostic_events').split('\n')[0]).toBe(TABLE_SCHEMAS.diagnostic_events.join(','));
  });

  it('adds numeric dictionary codes for repeated categorical labels', () => {
    const store = new SessionDataStore();
    const trial = store.startTrial({ condition: 'keyboard_only', trialMode: 'practice' });
    store.finishTrial(trial.trial_id, {
      durationMs: 1000,
      endReason: 'timeout',
      score: 0,
      lines: 0,
      piecesCount: 1,
    });
    store.addRow('pieces', {
      trial_id: trial.trial_id,
      piece_id: 'piece_1',
      piece_type: 'T',
    });
    store.addRow('gaze_aoi_classifications', {
      trial_id: trial.trial_id,
      piece_id: 'piece_1',
      t_trial_ms: 34,
      t_piece_ms: 34,
      primary_aoi: 'landing_zone',
      matching_aois: JSON.stringify(['landing_zone', 'stack_blocks']),
    });

    const dictionaryRows = store.getRows('dictionaries');
    const timeoutDictionary = dictionaryRows.find(
      (row) => row.dictionary_name === 'end_reason' && row.label === 'timeout',
    );

    expect(timeoutDictionary.code).toBe(3);
    expect(store.getRows('trials')[0]).toMatchObject({
      condition_code: 1,
      trial_mode_code: 1,
      end_reason_code: 3,
    });
    expect(store.getRows('pieces')[0]).toMatchObject({
      piece_type: 'T',
      piece_type_code: 6,
    });
    expect(store.getRows('gaze_aoi_classifications')[0]).toMatchObject({
      primary_aoi_code: 3,
      matching_aoi_codes: JSON.stringify([3, 4]),
    });
  });

  it('saves, recovers, and clears IndexedDB backup', async () => {
    const store = new SessionDataStore({ participantId: 'backup-pilot' });
    store.addRow('gaze_samples', {
      trial_id: 'trial_1',
      piece_id: 'piece_1',
      t_trial_ms: 34,
      t_piece_ms: 34,
      x: 100,
      y: 120,
      confidence: 0.9,
      valid: true,
    });

    await store.saveBackup();
    const recovered = new SessionDataStore();
    const result = await recovered.recoverBackup();

    expect(result.ok).toBe(true);
    expect(recovered.getRows('gaze_samples')).toHaveLength(1);

    await recovered.clearBackup();
    const empty = new SessionDataStore();
    await expect(empty.recoverBackup()).resolves.toBeNull();
  });
});
