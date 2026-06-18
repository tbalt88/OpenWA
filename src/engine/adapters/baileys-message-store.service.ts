import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysMessageStore } from '../types/baileys.types';

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class BaileysMessageStoreService implements BaileysMessageStore {
  constructor(
    @InjectRepository(BaileysStoredMessage, 'data')
    private readonly repo: Repository<BaileysStoredMessage>,
  ) {}

  async put(sessionId: string, msg: WAMessage): Promise<void> {
    const waMessageId = msg.key?.id;
    if (!waMessageId) {
      return;
    }
    const serializedMessage = JSON.stringify(msg, BufferJSON.replacer);
    // Idempotent: the same message arrives from the send return AND the messages.upsert echo.
    await this.repo.upsert({ sessionId, waMessageId, serializedMessage }, ['sessionId', 'waMessageId']);
    await this.enforceLimit(sessionId);
  }

  async getMessage(sessionId: string, messageId: string): Promise<WAMessage | null> {
    const row = await this.repo.findOne({ where: { sessionId, waMessageId: messageId } });
    if (!row) {
      return null;
    }
    return JSON.parse(row.serializedMessage, BufferJSON.reviver) as WAMessage;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  /**
   * Per-session row cap: keep the newest N rows, delete the rest.
   * Uses a NOT IN subquery over the N keep-IDs so ties in createdAt (fast inserts in tests)
   * don't incorrectly evict recently added rows.
   */
  private async enforceLimit(sessionId: string): Promise<void> {
    const limit = positiveIntFromEnv('BAILEYS_MESSAGE_STORE_LIMIT', 5000);
    const total = await this.repo.count({ where: { sessionId } });
    if (total <= limit) {
      return;
    }
    // Find the IDs of the N rows to keep (newest N by insertion order; waMessageId as stable tiebreaker).
    const keepRows = await this.repo.find({
      where: { sessionId },
      order: { createdAt: 'DESC', waMessageId: 'DESC' },
      take: limit,
      select: ['id'],
    });
    const keepIds = keepRows.map(r => r.id);
    await this.repo
      .createQueryBuilder()
      .delete()
      .where('sessionId = :sessionId', { sessionId })
      .andWhere('id NOT IN (:...keepIds)', { keepIds })
      .execute();
  }
}
