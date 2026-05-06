export interface WALabel {
  id: string;
  name: string;
  colorIndex: number;
  isActive: boolean;
  type: number;
}

export interface WALabelAssociation {
  labelId: string;
  associationId: string;
  type: string;
}

export interface WAChat {
  id: string;
  t: number;
  unreadCount: number;
  archive: boolean;
  name: string | null;
}

export interface WAContact {
  id: string;
  phoneNumber: string | null;
  pushname: string | null;
  name: string | null;
  shortName: string | null;
}

const DB_NAME = 'model-storage';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }
    const tx = db.transaction([storeName], 'readonly');
    const items: T[] = [];
    tx.objectStore(storeName).openCursor().onsuccess = (e) => {
      const cur = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cur) {
        items.push(cur.value as T);
        cur.continue();
      }
    };
    tx.oncomplete = () => resolve(items);
    tx.onerror = () => reject(tx.error);
  });
}

export async function readWhatsAppData(): Promise<{
  labels: WALabel[];
  associations: WALabelAssociation[];
  chats: WAChat[];
  contacts: WAContact[];
  jidToPhoneJid: Map<string, string>;
}> {
  const db = await openDb();
  try {
    const [labels, associations, rawChats, rawContacts] = await Promise.all([
      readAll<WALabel>(db, 'label'),
      readAll<WALabelAssociation>(db, 'label-association'),
      readAll<WAChat & { id?: unknown }>(db, 'chat'),
      readAll<WAContact & { id?: unknown; phoneNumber?: unknown; pushname?: unknown }>(
        db,
        'contact',
      ),
    ]);
    const chats: WAChat[] = rawChats
      .filter((c) => typeof c.id === 'string')
      .map((c) => ({
        id: c.id as string,
        t: typeof c.t === 'number' ? c.t : 0,
        unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
        archive: Boolean(c.archive),
        name: typeof c.name === 'string' ? c.name : null,
      }));
    const contacts: WAContact[] = rawContacts
      .filter((c) => typeof c.id === 'string')
      .map((c) => {
        const r = c as unknown as Record<string, unknown>;
        return {
          id: c.id as string,
          phoneNumber:
            typeof r.phoneNumber === 'string' ? (r.phoneNumber as string) : null,
          pushname: typeof r.pushname === 'string' ? (r.pushname as string) : null,
          name: typeof r.name === 'string' ? (r.name as string) : null,
          shortName:
            typeof r.shortName === 'string' ? (r.shortName as string) : null,
        };
      });

    const jidToPhoneJid = new Map<string, string>();
    for (const c of contacts) {
      if (c.phoneNumber && c.phoneNumber.includes('@c.us')) {
        jidToPhoneJid.set(c.id, c.phoneNumber);
      }
    }

    return { labels, associations, chats, contacts, jidToPhoneJid };
  } finally {
    db.close();
  }
}

export function jidToPhone(jid: string): string | null {
  const m = jid.match(/^(\d+)@c\.us$/);
  return m ? '+' + m[1] : null;
}

export function resolvePhone(
  jid: string,
  jidToPhoneJid: Map<string, string>,
): string | null {
  const direct = jidToPhone(jid);
  if (direct) return direct;
  const mapped = jidToPhoneJid.get(jid);
  return mapped ? jidToPhone(mapped) : null;
}

export function isUserChat(jid: string): boolean {
  return /@(c\.us|lid)$/.test(jid) && !jid.includes('-');
}
