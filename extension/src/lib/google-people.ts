// Thin wrapper around Google People API for contact sync.
// Auth via chrome.identity.getAuthToken (extension OAuth, no popup needed
// after first consent).

export interface GoogleContact {
  resourceName: string;
  displayName: string | null;
  phones: string[];
  emails: string[];
  etag?: string;
}

interface RawConnection {
  resourceName: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  phoneNumbers?: { value?: string; canonicalForm?: string; type?: string }[];
  emailAddresses?: { value?: string }[];
}

const PERSON_FIELDS =
  'names,phoneNumbers,emailAddresses,metadata';

// chrome.identity is not exposed in content scripts — proxy through the
// background service worker which has full extension privileges.

export async function getGoogleAuthToken(interactive = true): Promise<string> {
  const response = (await chrome.runtime.sendMessage({
    type: 'GET_GOOGLE_TOKEN',
    interactive,
  })) as { token?: string; error?: string } | undefined;
  if (!response) throw new Error('background 无响应');
  if (response.error) throw new Error(response.error);
  if (!response.token) throw new Error('未获取到 Google 授权令牌');
  return response.token;
}

export async function clearCachedToken(token: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'CLEAR_GOOGLE_TOKEN', token });
}

async function googleFetch(
  url: string,
  init: RequestInit = {},
  token?: string,
): Promise<Response> {
  const t = token ?? (await getGoogleAuthToken());
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 401) {
    await clearCachedToken(t);
    throw new Error('授权过期，请重试');
  }
  return res;
}

function normalizeConnection(c: RawConnection): GoogleContact {
  const displayName =
    c.names?.[0]?.displayName ||
    [c.names?.[0]?.givenName, c.names?.[0]?.familyName]
      .filter(Boolean)
      .join(' ') ||
    null;

  const phones = (c.phoneNumbers ?? [])
    .map((p) => p.canonicalForm || p.value || '')
    .map(normalizePhone)
    .filter(Boolean) as string[];

  const emails = (c.emailAddresses ?? [])
    .map((e) => e.value)
    .filter(Boolean) as string[];

  return {
    resourceName: c.resourceName,
    displayName,
    phones,
    emails,
    etag: c.etag,
  };
}

export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return `+${digits}`;
}

export async function listGoogleContacts(): Promise<GoogleContact[]> {
  const token = await getGoogleAuthToken();
  const all: GoogleContact[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      'https://people.googleapis.com/v1/people/me/connections',
    );
    url.searchParams.set('personFields', PERSON_FIELDS);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await googleFetch(url.toString(), {}, token);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google People API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      connections?: RawConnection[];
      nextPageToken?: string;
      totalPeople?: number;
    };
    for (const conn of data.connections ?? []) {
      all.push(normalizeConnection(conn));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

export async function createGoogleContact(input: {
  displayName: string;
  phone: string;
}): Promise<GoogleContact> {
  const body = {
    names: [{ givenName: input.displayName }],
    phoneNumbers: [{ value: input.phone }],
  };
  const res = await googleFetch(
    'https://people.googleapis.com/v1/people:createContact',
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new Error(`Google People API ${res.status}: ${await res.text()}`);
  }
  const conn = (await res.json()) as RawConnection;
  return normalizeConnection(conn);
}
