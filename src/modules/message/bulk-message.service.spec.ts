import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BulkMessageService, resolveFinalBatchStatus } from './bulk-message.service';
import { MessageBatch, BatchStatus } from './entities/message-batch.entity';
import { SessionService } from '../session/session.service';

/** Regression lock for the terminal-status decision (cancel-clobber + stopOnError overwrite bugs). */
describe('resolveFinalBatchStatus', () => {
  it('CANCELLED wins even when messages were sent/failed (no clobber back to PROCESSING/COMPLETED)', () => {
    expect(resolveFinalBatchStatus(true, false, { sent: 3, failed: 1 })).toBe(BatchStatus.CANCELLED);
  });

  it('cancellation takes precedence over stop-on-error', () => {
    expect(resolveFinalBatchStatus(true, true, { sent: 0, failed: 1 })).toBe(BatchStatus.CANCELLED);
  });

  it('stopOnError → FAILED even when some messages already sent (not COMPLETED)', () => {
    expect(resolveFinalBatchStatus(false, true, { sent: 5, failed: 1 })).toBe(BatchStatus.FAILED);
  });

  it('all attempts failed → FAILED', () => {
    expect(resolveFinalBatchStatus(false, false, { sent: 0, failed: 4 })).toBe(BatchStatus.FAILED);
  });

  it('some sent (with or without failures) → COMPLETED', () => {
    expect(resolveFinalBatchStatus(false, false, { sent: 4, failed: 0 })).toBe(BatchStatus.COMPLETED);
    expect(resolveFinalBatchStatus(false, false, { sent: 3, failed: 1 })).toBe(BatchStatus.COMPLETED);
  });
});

/** Regression lock: orphaned (restart-interrupted) PROCESSING batches are transitioned. */
describe('BulkMessageService.onApplicationBootstrap', () => {
  let service: BulkMessageService;
  let repo: { find: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        { provide: SessionService, useValue: { getEngine: jest.fn() } },
      ],
    }).compile();
    service = module.get<BulkMessageService>(BulkMessageService);
  });

  it('marks an orphaned PROCESSING batch FAILED on startup (no auto-resume)', async () => {
    const batch = { id: 'b1', status: BatchStatus.PROCESSING } as unknown as MessageBatch;
    repo.find.mockResolvedValue([batch]);

    await service.onApplicationBootstrap();

    expect(repo.find).toHaveBeenCalledWith({ where: { status: BatchStatus.PROCESSING } });
    expect(batch.status).toBe(BatchStatus.FAILED);
    expect(repo.save).toHaveBeenCalledWith(batch);
  });

  it('does nothing when there are no orphaned batches', async () => {
    repo.find.mockResolvedValue([]);
    await service.onApplicationBootstrap();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
