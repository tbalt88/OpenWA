import { DataSource, Repository } from 'typeorm';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStoreService } from './baileys-message-store.service';

describe('BaileysMessageStoreService', () => {
  let ds: DataSource;
  let repo: Repository<BaileysStoredMessage>;
  let service: BaileysMessageStoreService;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [BaileysStoredMessage], synchronize: true });
    await ds.initialize();
    repo = ds.getRepository(BaileysStoredMessage);
    service = new BaileysMessageStoreService(repo);
  });

  afterEach(async () => {
    await ds.destroy();
    delete process.env.BAILEYS_MESSAGE_STORE_LIMIT;
  });

  // Partial WAMessage fixture — cast through unknown so strict checks don't fire on the incomplete shape.
  const msg = (id: string) =>
    ({
      key: { id, remoteJid: '1@s.whatsapp.net', fromMe: false },
      message: { conversation: id },
    }) as unknown as Parameters<BaileysMessageStoreService['put']>[1];

  it('round-trips a WAMessage through BufferJSON', async () => {
    await service.put('s1', msg('M1'));
    const got = await service.getMessage('s1', 'M1');
    expect(got?.key?.id).toBe('M1');
    expect(got?.message?.conversation).toBe('M1');
  });

  it('returns null for an unknown id and is session-scoped', async () => {
    await service.put('s1', msg('M1'));
    expect(await service.getMessage('s1', 'NOPE')).toBeNull();
    expect(await service.getMessage('s2', 'M1')).toBeNull();
  });

  it('is idempotent on (sessionId, waMessageId)', async () => {
    await service.put('s1', msg('M1'));
    await service.put('s1', msg('M1'));
    expect(await repo.count({ where: { sessionId: 's1' } })).toBe(1);
  });

  it('evicts oldest beyond the per-session cap', async () => {
    process.env.BAILEYS_MESSAGE_STORE_LIMIT = '2';
    const s = new BaileysMessageStoreService(repo);
    await s.put('s1', msg('M1'));
    await s.put('s1', msg('M2'));
    await s.put('s1', msg('M3'));
    expect(await s.getMessage('s1', 'M1')).toBeNull(); // oldest evicted
    expect(await s.getMessage('s1', 'M3')).not.toBeNull();
    expect(await repo.count({ where: { sessionId: 's1' } })).toBeLessThanOrEqual(2);
  });

  it('clearSession removes only that session', async () => {
    await service.put('s1', msg('M1'));
    await service.put('s2', msg('M2'));
    await service.clearSession('s1');
    expect(await service.getMessage('s1', 'M1')).toBeNull();
    expect(await service.getMessage('s2', 'M2')).not.toBeNull();
  });
});
