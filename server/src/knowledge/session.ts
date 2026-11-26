import { knowledgeOn } from '../connectors';
import type { DataSource } from '../datasource/DataSource';
import type { KnowledgeEvent } from '../../../shared/types';

/**
 * What a session used, for a room whose knowledge sheet is on. With the sheet
 * off the source is not asked, so no transcript is read on this feature's
 * account. Nothing here reaches the network: the list is the transcript's.
 */
export async function sessionKnowledge(source: Pick<DataSource, 'getKnowledge'>, sessionId: string, roomId: string): Promise<KnowledgeEvent[]> {
  if (!knowledgeOn(roomId)) return [];
  return (await source.getKnowledge?.(sessionId)) ?? [];
}
