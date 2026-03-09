const storageKey = 'rp-archiv-v1';
const configKey = 'rp-cloud-config';
const mediaDbName = 'rp-media-db';
const mediaStoreName = 'media_assets';
const mediaDbVersion = 1;

const state = {
  chats: [],
  selectedChatId: null,
  markerByChat: {},
  cloudMediaByChat: {},
  // Session-only map: chatId -> { normalizedMediaName: objectUrl }
  sessionMediaByChat: {},
  mediaLoadInFlight: {},
  cloudFetchInFlight: {},
  oneDriveClient: null,
  oneDriveAccount: null,
  config: loadConfig(),
};

const mediaDbPromise = openMediaDb();

const ui = {
  chatFileInput: document.getElementById('chatFileInput'),
  chatList: document.getElementById('chatList'),
  chatTitle: document.getElementById('chatTitle'),
  chatMeta: document.getElementById('chatMeta'),
  messages: document.getElementById('messages'),
  messageTemplate: document.getElementById('messageTemplate'),
  setMarkerBtn: document.getElementById('setMarkerBtn'),
  jumpMarkerBtn: document.getElementById('jumpMarkerBtn'),
  toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
  sidebar: document.getElementById('sidebar'),
  supabaseUrl: document.getElementById('supabaseUrl'),
  supabaseKey: document.getElementById('supabaseKey'),
  userId: document.getElementById('userId'),
  oneDriveClientId: document.getElementById('oneDriveClientId'),
  oneDriveRootPath: document.getElementById('oneDriveRootPath'),
  oneDriveConnectBtn: document.getElementById('oneDriveConnectBtn'),
  oneDriveDisconnectBtn: document.getElementById('oneDriveDisconnectBtn'),
  oneDriveStatus: document.getElementById('oneDriveStatus'),
  saveConfigBtn: document.getElementById('saveConfigBtn'),
};

boot();

function boot() {
  loadLocalState();
  hydrateConfigForm();
  bindEvents();
  initOneDrive().catch(console.error);
  renderChatList();
  if (state.chats.length > 0) {
    selectChat(state.chats[0].id);
  }
}

function bindEvents() {
  ui.chatFileInput.addEventListener('change', handleImportFile);
  ui.setMarkerBtn.addEventListener('click', saveMarkerAtCurrentViewport);
  ui.jumpMarkerBtn.addEventListener('click', jumpToMarker);
  ui.toggleSidebarBtn.addEventListener('click', () => {
    ui.sidebar.classList.toggle('open');
  });

  ui.saveConfigBtn.addEventListener('click', async () => {
    state.config = {
      supabaseUrl: ui.supabaseUrl.value.trim(),
      supabaseKey: ui.supabaseKey.value.trim(),
      userId: ui.userId.value.trim(),
      oneDriveClientId: ui.oneDriveClientId.value.trim(),
      oneDriveRootPath: sanitizeOneDriveRoot(ui.oneDriveRootPath.value.trim()),
    };
    localStorage.setItem(configKey, JSON.stringify(state.config));
    await initOneDrive().catch(console.error);

    if (isCloudEnabled()) {
      await syncAllToCloud();
      await loadMarkersFromCloud();
      renderSelectedChat();
    }
  });

  ui.oneDriveConnectBtn.addEventListener('click', () => {
    connectOneDrive().catch((error) => {
      console.error(error);
      alert(`OneDrive Login fehlgeschlagen: ${error.message}`);
    });
  });

  ui.oneDriveDisconnectBtn.addEventListener('click', () => {
    disconnectOneDrive().catch((error) => {
      console.error(error);
      alert(`OneDrive Logout fehlgeschlagen: ${error.message}`);
    });
  });
}

function sanitizeOneDriveRoot(path) {
  return String(path || 'Apps/RoleplayArchivMedia')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '') || 'Apps/RoleplayArchivMedia';
}

function isOneDriveConfigured() {
  return Boolean(state.config.oneDriveClientId);
}

function updateOneDriveStatus() {
  if (!ui.oneDriveStatus) return;
  if (!isOneDriveConfigured()) {
    ui.oneDriveStatus.textContent = 'OneDrive: Client ID fehlt';
    return;
  }
  if (state.oneDriveAccount?.username) {
    ui.oneDriveStatus.textContent = `OneDrive: verbunden als ${state.oneDriveAccount.username}`;
    return;
  }
  ui.oneDriveStatus.textContent = 'OneDrive: nicht verbunden';
}

async function initOneDrive() {
  if (!isOneDriveConfigured() || !window.msal?.PublicClientApplication) {
    state.oneDriveClient = null;
    state.oneDriveAccount = null;
    updateOneDriveStatus();
    return;
  }

  const client = new window.msal.PublicClientApplication({
    auth: {
      clientId: state.config.oneDriveClientId,
      authority: 'https://login.microsoftonline.com/consumers',
      redirectUri: window.location.origin + window.location.pathname,
    },
    cache: {
      cacheLocation: 'localStorage',
    },
  });

  if (typeof client.initialize === 'function') {
    await client.initialize();
  }

  state.oneDriveClient = client;
  const redirectResult = await client.handleRedirectPromise().catch(() => null);
  const accounts = client.getAllAccounts();
  state.oneDriveAccount = redirectResult?.account || accounts[0] || null;
  if (state.oneDriveAccount) {
    client.setActiveAccount(state.oneDriveAccount);
  }
  updateOneDriveStatus();
}

function getOneDriveScopes() {
  return ['Files.ReadWrite', 'User.Read'];
}

async function connectOneDrive() {
  if (!isOneDriveConfigured()) {
    throw new Error('Bitte zuerst OneDrive Client ID speichern.');
  }
  if (!state.oneDriveClient) {
    await initOneDrive();
  }
  const response = await state.oneDriveClient.loginPopup({
    scopes: getOneDriveScopes(),
    prompt: 'select_account',
  });
  state.oneDriveAccount = response.account || state.oneDriveClient.getActiveAccount();
  if (state.oneDriveAccount) {
    state.oneDriveClient.setActiveAccount(state.oneDriveAccount);
  }
  updateOneDriveStatus();
}

async function disconnectOneDrive() {
  if (!state.oneDriveClient || !state.oneDriveAccount) {
    state.oneDriveAccount = null;
    updateOneDriveStatus();
    return;
  }

  const account = state.oneDriveAccount;
  state.oneDriveAccount = null;
  updateOneDriveStatus();

  await state.oneDriveClient.logoutPopup({
    account,
    mainWindowRedirectUri: window.location.origin + window.location.pathname,
  });
}

async function acquireOneDriveToken(interactive) {
  if (!state.oneDriveClient || !state.oneDriveAccount) {
    if (!interactive) {
      throw new Error('OneDrive nicht verbunden.');
    }
    await connectOneDrive();
  }

  const request = {
    scopes: getOneDriveScopes(),
    account: state.oneDriveAccount || state.oneDriveClient.getActiveAccount(),
  };

  try {
    const silent = await state.oneDriveClient.acquireTokenSilent(request);
    return silent.accessToken;
  } catch (error) {
    if (!interactive) {
      throw error;
    }
    const popup = await state.oneDriveClient.acquireTokenPopup(request);
    if (popup.account) {
      state.oneDriveAccount = popup.account;
      state.oneDriveClient.setActiveAccount(popup.account);
      updateOneDriveStatus();
    }
    return popup.accessToken;
  }
}

function oneDrivePathJoin(...parts) {
  return parts
    .map((part) => String(part || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function sanitizeOneDriveFileName(name) {
  return String(name || 'file')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim();
}

function encodeGraphPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function uploadMediaToOneDrive(chatId, sourceName, blob) {
  const token = await acquireOneDriveToken(true);
  const fileName = sanitizeOneDriveFileName(basename(sourceName));
  const fullPath = oneDrivePathJoin(state.config.oneDriveRootPath, chatId, fileName);
  const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeGraphPath(fullPath)}:/content`;

  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OneDrive Upload fehlgeschlagen (${response.status}): ${text}`);
  }

  const item = await response.json();
  return {
    itemId: item.id,
    path: fullPath,
    name: fileName,
  };
}

function setCloudMediaMapping(chatId, mediaKey, descriptor) {
  const normalized = normalizeMediaKey(mediaKey);
  if (!state.cloudMediaByChat[chatId]) {
    state.cloudMediaByChat[chatId] = {};
  }
  state.cloudMediaByChat[chatId][normalized] = descriptor;
}

function getCloudMediaDescriptor(chatId, mediaName) {
  const map = state.cloudMediaByChat[chatId];
  if (!map) return null;
  const exact = map[normalizeMediaKey(mediaName)];
  if (exact) return exact;
  return map[normalizeMediaKey(basename(mediaName))] || null;
}

async function ensureCloudMediaLoaded(chatId, mediaName) {
  const descriptor = getCloudMediaDescriptor(chatId, mediaName);
  if (!descriptor) return;

  const resolved = state.sessionMediaByChat[chatId] || {};
  const existing = resolveMediaUrl(mediaName, resolved);
  if (existing) return;

  const key = `${chatId}|${normalizeMediaKey(mediaName)}`;
  if (state.cloudFetchInFlight[key]) return;

  const task = (async () => {
    const token = await acquireOneDriveToken(false);
    const endpoint = descriptor.itemId
      ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(descriptor.itemId)}/content`
      : `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeGraphPath(descriptor.path)}:/content`;

    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`OneDrive Download fehlgeschlagen (${response.status})`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const normalizedOriginal = normalizeMediaKey(mediaName);
    const normalizedBase = normalizeMediaKey(basename(mediaName));

    if (!state.sessionMediaByChat[chatId]) {
      state.sessionMediaByChat[chatId] = {};
    }
    state.sessionMediaByChat[chatId][normalizedOriginal] = url;
    state.sessionMediaByChat[chatId][normalizedBase] = url;

    await persistMediaBlob(chatId, normalizedOriginal, blob);
    await persistMediaBlob(chatId, normalizedBase, blob);
  })()
    .then(() => {
      if (state.selectedChatId === chatId) {
        renderSelectedChat();
      }
    })
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      delete state.cloudFetchInFlight[key];
    });

  state.cloudFetchInFlight[key] = task;
}

async function deleteOneDriveChatFolder(chatId) {
  if (!state.oneDriveClient || !state.oneDriveAccount) return;

  const token = await acquireOneDriveToken(false);
  const folderPath = oneDrivePathJoin(state.config.oneDriveRootPath, chatId);
  const endpoint = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeGraphPath(folderPath)}`;

  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) return;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OneDrive Ordner konnte nicht gelöscht werden: ${response.status} ${text}`);
  }
}

function openMediaDb() {
  if (!('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(mediaDbName, mediaDbVersion);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(mediaStoreName)) {
        const store = db.createObjectStore(mediaStoreName, { keyPath: 'id' });
        store.createIndex('chatId', 'chatId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistMediaBlob(chatId, mediaKey, blob) {
  const db = await mediaDbPromise;
  if (!db) return;

  const normalizedKey = normalizeMediaKey(mediaKey);
  const id = `${chatId}|${normalizedKey}`;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(mediaStoreName, 'readwrite');
    const store = tx.objectStore(mediaStoreName);
    store.put({
      id,
      chatId,
      mediaKey: normalizedKey,
      blob,
      updatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

async function ensureChatMediaLoaded(chatId) {
  if (!chatId || state.sessionMediaByChat[chatId]) return;
  if (state.mediaLoadInFlight[chatId]) return state.mediaLoadInFlight[chatId];

  const loadPromise = (async () => {
    const db = await mediaDbPromise;
    if (!db) return;

    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(mediaStoreName, 'readonly');
      const store = tx.objectStore(mediaStoreName);
      const index = store.index('chatId');
      const req = index.getAll(IDBKeyRange.only(chatId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    if (!records.length) return;

    const mediaIndex = {};
    for (const record of records) {
      if (!record?.blob || !record?.mediaKey) continue;
      mediaIndex[record.mediaKey] = URL.createObjectURL(record.blob);
    }

    if (Object.keys(mediaIndex).length > 0) {
      cleanupSessionMedia(chatId);
      state.sessionMediaByChat[chatId] = mediaIndex;
    }
  })()
    .catch((error) => {
      console.error('Media load failed', error);
    })
    .finally(() => {
      delete state.mediaLoadInFlight[chatId];
    });

  state.mediaLoadInFlight[chatId] = loadPromise;
  return loadPromise;
}

async function deletePersistedMediaForChat(chatId) {
  const db = await mediaDbPromise;
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(mediaStoreName, 'readwrite');
    const store = tx.objectStore(mediaStoreName);
    const index = store.index('chatId');
    const req = index.openKeyCursor(IDBKeyRange.only(chatId));

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
  });
}

function loadLocalState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.chats = Array.isArray(parsed.chats) ? parsed.chats : [];
    state.markerByChat = parsed.markerByChat || {};
    state.cloudMediaByChat = parsed.cloudMediaByChat || {};
  } catch {
    state.chats = [];
    state.markerByChat = {};
    state.cloudMediaByChat = {};
  }
}

function persistLocalState() {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      chats: state.chats,
      markerByChat: state.markerByChat,
      cloudMediaByChat: state.cloudMediaByChat,
    })
  );
}

function loadConfig() {
  const raw = localStorage.getItem(configKey);
  if (!raw) {
    return {
      supabaseUrl: '',
      supabaseKey: '',
      userId: '',
      oneDriveClientId: '',
      oneDriveRootPath: 'Apps/RoleplayArchivMedia',
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      supabaseUrl: parsed.supabaseUrl || '',
      supabaseKey: parsed.supabaseKey || '',
      userId: parsed.userId || '',
      oneDriveClientId: parsed.oneDriveClientId || '',
      oneDriveRootPath: sanitizeOneDriveRoot(parsed.oneDriveRootPath || 'Apps/RoleplayArchivMedia'),
    };
  } catch {
    return {
      supabaseUrl: '',
      supabaseKey: '',
      userId: '',
      oneDriveClientId: '',
      oneDriveRootPath: 'Apps/RoleplayArchivMedia',
    };
  }
}

function hydrateConfigForm() {
  ui.supabaseUrl.value = state.config.supabaseUrl || '';
  ui.supabaseKey.value = state.config.supabaseKey || '';
  ui.userId.value = state.config.userId || '';
  ui.oneDriveClientId.value = state.config.oneDriveClientId || '';
  ui.oneDriveRootPath.value = state.config.oneDriveRootPath || 'Apps/RoleplayArchivMedia';
  updateOneDriveStatus();
}

function isCloudEnabled() {
  return Boolean(
    state.config.supabaseUrl && state.config.supabaseKey && state.config.userId
  );
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (/\.zip$/i.test(file.name)) {
      await importFromZip(file);
    } else {
      await importFromTxt(file);
    }
  } catch (error) {
    console.error(error);
    alert(`Import fehlgeschlagen: ${error.message}`);
  } finally {
    ui.chatFileInput.value = '';
  }
}

async function importFromTxt(file) {
  const content = await file.text();
  const messages = parseWhatsAppExport(content, {});
  if (messages.length === 0) {
    alert('Keine Nachrichten erkannt. Bitte WhatsApp .txt oder .zip Export nutzen.');
    return;
  }

  const chat = {
    id: crypto.randomUUID(),
    title: file.name.replace(/\.txt$/i, ''),
    createdAt: new Date().toISOString(),
    messages,
  };

  addChatToState(chat);
}

async function importFromZip(file) {
  if (!window.JSZip) {
    throw new Error('JSZip nicht geladen. Bitte Internetzugang fuer CDN pruefen.');
  }

  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const textEntry = pickWhatsAppTextEntry(files);

  if (!textEntry) {
    throw new Error('Im ZIP wurde keine WhatsApp .txt Datei gefunden (z.B. _chat.txt).');
  }

  const chatId = crypto.randomUUID();
  const content = await textEntry.async('string');
  const mediaIndex = await extractImageMedia(zip, files, chatId);
  const messages = parseWhatsAppExport(content, mediaIndex);

  if (messages.length === 0) {
    throw new Error('Nachrichten konnten aus der ZIP nicht gelesen werden.');
  }

  const chat = {
    id: chatId,
    title: file.name.replace(/\.zip$/i, ''),
    createdAt: new Date().toISOString(),
    messages,
  };

  state.sessionMediaByChat[chat.id] = mediaIndex;
  addChatToState(chat);
}

function addChatToState(chat) {
  state.chats.unshift(chat);
  persistLocalState();
  renderChatList();
  selectChat(chat.id);

  if (isCloudEnabled()) {
    pushChatToCloud(chat).catch(console.error);
  }
}

function pickWhatsAppTextEntry(files) {
  const textFiles = files
    .filter((entry) => /\.txt$/i.test(entry.name))
    .filter((entry) => !entry.name.startsWith('__MACOSX/'));

  if (textFiles.length === 0) return null;

  const preferred = textFiles.find((entry) => /(^|\/)_chat\.txt$/i.test(entry.name));
  return preferred || textFiles[0];
}

async function extractImageMedia(zip, files, chatId) {
  const mediaIndex = {};
  const uploadEnabled = Boolean(state.oneDriveClient && state.oneDriveAccount && isOneDriveConfigured());

  for (const entry of files) {
    if (!isImageFile(entry.name) || entry.name.startsWith('__MACOSX/')) {
      continue;
    }

    const blob = await zip.file(entry.name).async('blob');
    const url = URL.createObjectURL(blob);
    const normalizedPath = normalizeMediaKey(entry.name);
    const normalizedBase = normalizeMediaKey(basename(entry.name));

    mediaIndex[normalizedPath] = url;
    mediaIndex[normalizedBase] = url;

    await persistMediaBlob(chatId, normalizedPath, blob);
    await persistMediaBlob(chatId, normalizedBase, blob);

    if (uploadEnabled) {
      try {
        const descriptor = await uploadMediaToOneDrive(chatId, entry.name, blob);
        setCloudMediaMapping(chatId, normalizedPath, descriptor);
        setCloudMediaMapping(chatId, normalizedBase, descriptor);
      } catch (error) {
        console.error('OneDrive upload skipped for media', error);
      }
    }
  }

  persistLocalState();
  return mediaIndex;
}

function isImageFile(fileName) {
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(fileName);
}

function parseWhatsAppExport(content, mediaIndex) {
  const lines = content.split(/\r?\n/);
  const messages = [];

  // Handles formats like:
  // 09.03.26, 14:15 - Name: Text
  // [09.03.26, 14:15:22] Name: Text
  const pattern = /^(?:\u200e|\u200f)?(?:\[)?(\d{1,2}[./]\d{1,2}[./]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s(?:-\s)?([^:]+):\s([\s\S]*)$/;

  let current = null;

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      const [, datePart, timePart, senderRaw, text] = match;
      const sender = senderRaw.trim();
      const sentAt = parseLocalDate(datePart, timePart);
      current = {
        sender,
        text: (text || '').trim(),
        sentAt,
      };
      messages.push(current);
      continue;
    }

    if (current) {
      current.text += `\n${line}`;
    }
  }

  return messages.map((m, i) => enrichMessageWithMedia(m, i + 1, mediaIndex));
}

function enrichMessageWithMedia(message, seq, mediaIndex) {
  const mediaName = extractMediaReference(message.text);
  if (!mediaName) {
    return { ...message, seq };
  }

  const mediaType = inferMediaType(mediaName);
  const mediaUrl = resolveMediaUrl(mediaName, mediaIndex);
  const cleanedText = cleanupMediaMarkerText(message.text, mediaName);

  return {
    ...message,
    seq,
    text: cleanedText,
    mediaName,
    mediaType,
    hasMedia: Boolean(mediaUrl),
  };
}

function extractMediaReference(text) {
  if (!text) return null;

  // Normalize invisible marks sometimes present in WhatsApp exports.
  const clean = text.replace(/[\u200e\u200f]/g, '');

  const matches = [
    clean.match(/<(?:Anhang|attached):\s*([^>]+)>/i),
    clean.match(/(?:\bDatei angeh[aä]ngt:\s*|\bFile attached:\s*)([^\n]+)/i),
    clean.match(/\b([A-Z]{3}-\d{8}-WA\d{4}\.[a-z0-9]{3,5})\b/i),
    clean.match(/\b([^\s<>:"/\\|?*]+\.(?:jpe?g|png|gif|webp|bmp|heic|heif))\b/i),
  ];

  for (const match of matches) {
    if (match && match[1]) {
      return match[1].replace(/[\u200e\u200f]/g, '').trim();
    }
  }

  return null;
}

function cleanupMediaMarkerText(text, mediaName) {
  let cleaned = text;

  cleaned = cleaned.replace(new RegExp(`<\\s*(?:Anhang|attached):\\s*${escapeRegExp(mediaName)}\\s*>`, 'i'), '');
  cleaned = cleaned.replace(/\((?:Datei angeh[aä]ngt|File attached)\)/gi, '');
  cleaned = cleaned.replace(/(?:Datei angeh[aä]ngt:|File attached:)\s*[^\n]+/gi, '');
  cleaned = cleaned.replace(/\b(?:Anhang ausgelassen|Media omitted)\b/gi, '');
  cleaned = cleaned.replace(/^[\s,-]+|[\s,-]+$/g, '');

  return cleaned.trim();
}

function inferMediaType(mediaName) {
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(mediaName)) {
    return 'image';
  }
  return 'file';
}

function resolveMediaUrl(mediaName, mediaIndex) {
  const exact = mediaIndex[normalizeMediaKey(mediaName)];
  if (exact) return exact;

  return mediaIndex[normalizeMediaKey(basename(mediaName))] || '';
}

function normalizeMediaKey(value) {
  return String(value).replaceAll('\\', '/').trim().toLowerCase();
}

function basename(path) {
  return String(path).replaceAll('\\', '/').split('/').pop() || path;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLocalDate(datePart, timePart) {
  const dateParts = datePart.split(/[./]/).map((n) => parseInt(n, 10));
  let [day, month, year] = dateParts;
  if (year < 100) {
    year += 2000;
  }

  const timeParts = timePart.split(':').map((n) => parseInt(n, 10));
  const [hour, minute, second = 0] = timeParts;

  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function renderChatList() {
  ui.chatList.innerHTML = '';

  for (const chat of state.chats) {
    const item = document.createElement('article');
    item.className = `chat-item ${chat.id === state.selectedChatId ? 'active' : ''}`;
    const markerSeq = state.markerByChat[chat.id]?.seq;

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'chat-open';
    openBtn.innerHTML = `
      <h3>${escapeHtml(chat.title)}</h3>
      <p>${chat.messages.length} Nachrichten${markerSeq ? ` • Marker bei #${markerSeq}` : ''}</p>
    `;

    openBtn.addEventListener('click', () => {
      selectChat(chat.id);
      if (window.innerWidth <= 860) {
        ui.sidebar.classList.remove('open');
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'chat-delete';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', () => {
      deleteChat(chat.id);
    });

    item.appendChild(openBtn);
    item.appendChild(deleteBtn);
    ui.chatList.appendChild(item);
  }
}

function deleteChat(chatId) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return;

  const ok = window.confirm(`Chat "${chat.title}" wirklich löschen?`);
  if (!ok) return;

  cleanupSessionMedia(chatId);
  deletePersistedMediaForChat(chatId).catch(console.error);
  delete state.cloudMediaByChat[chatId];
  delete state.markerByChat[chatId];
  state.chats = state.chats.filter((c) => c.id !== chatId);

  if (state.selectedChatId === chatId) {
    state.selectedChatId = state.chats[0]?.id || null;
  }

  persistLocalState();
  renderChatList();
  renderSelectedChat();

  if (isCloudEnabled()) {
    deleteChatInCloud(chatId).catch(console.error);
  }
  deleteOneDriveChatFolder(chatId).catch(console.error);
}

function cleanupSessionMedia(chatId) {
  const mediaIndex = state.sessionMediaByChat[chatId];
  if (!mediaIndex) return;

  const uniqueUrls = new Set(Object.values(mediaIndex));
  for (const url of uniqueUrls) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }

  delete state.sessionMediaByChat[chatId];
}

function selectChat(chatId) {
  state.selectedChatId = chatId;
  renderChatList();
  renderSelectedChat();
  ensureChatMediaLoaded(chatId).then(() => {
    if (state.selectedChatId === chatId) {
      renderSelectedChat();
    }
  });
}

function getSelectedChat() {
  return state.chats.find((c) => c.id === state.selectedChatId) || null;
}

function renderSelectedChat() {
  const chat = getSelectedChat();
  ui.messages.innerHTML = '';

  if (!chat) {
    ui.chatTitle.textContent = 'Kein Chat ausgewählt';
    ui.chatMeta.textContent = 'Importiere einen WhatsApp Export (.txt oder .zip)';
    ui.setMarkerBtn.disabled = true;
    ui.jumpMarkerBtn.disabled = true;
    return;
  }

  ui.chatTitle.textContent = chat.title;
  ui.chatMeta.textContent = `${chat.messages.length} Nachrichten`;
  ui.setMarkerBtn.disabled = false;
  ui.jumpMarkerBtn.disabled = !state.markerByChat[chat.id];

  const marker = state.markerByChat[chat.id];

  let me = null;
  for (const msg of chat.messages) {
    if (!me) me = msg.sender;

    if (marker?.seq === msg.seq) {
      const markerEl = document.createElement('div');
      markerEl.className = 'marker';
      markerEl.textContent = 'Weiterlesen ab hier';
      ui.messages.appendChild(markerEl);
    }

    const clone = ui.messageTemplate.content.firstElementChild.cloneNode(true);
    const isOut = msg.sender === me;
    clone.classList.add(isOut ? 'out' : 'in');
    clone.dataset.seq = String(msg.seq);

    clone.querySelector('.sender').textContent = msg.sender;
    clone.querySelector('.text').textContent = msg.text || '';
    clone.querySelector('.time').textContent = formatTime(msg.sentAt);

    attachMediaNode(clone.querySelector('.bubble'), chat.id, msg);

    ui.messages.appendChild(clone);
  }
}

function attachMediaNode(bubbleNode, chatId, msg) {
  if (msg.mediaType !== 'image' || !msg.mediaName) return;

  const mediaIndex = state.sessionMediaByChat[chatId] || {};
  const url = resolveMediaUrl(msg.mediaName, mediaIndex);

  if (!url) {
    const cloudDescriptor = getCloudMediaDescriptor(chatId, msg.mediaName);
    if (cloudDescriptor) {
      ensureCloudMediaLoaded(chatId, msg.mediaName);
    }
    const missing = document.createElement('p');
    missing.className = 'media-missing';
    missing.textContent = cloudDescriptor
      ? `[Bild wird aus OneDrive geladen: ${msg.mediaName}]`
      : `[Bild: ${msg.mediaName}]`;
    bubbleNode.insertBefore(missing, bubbleNode.querySelector('.text'));
    return;
  }

  const img = document.createElement('img');
  img.className = 'media-image';
  img.src = url;
  img.alt = msg.mediaName;
  img.loading = 'lazy';
  bubbleNode.insertBefore(img, bubbleNode.querySelector('.text'));
}

function formatTime(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

function saveMarkerAtCurrentViewport() {
  const chat = getSelectedChat();
  if (!chat) return;

  const rows = Array.from(ui.messages.querySelectorAll('.message-row'));
  if (rows.length === 0) return;

  const containerTop = ui.messages.getBoundingClientRect().top;
  let best = rows[0];
  let bestDistance = Infinity;

  for (const row of rows) {
    const distance = Math.abs(row.getBoundingClientRect().top - containerTop);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }

  const seq = Number(best.dataset.seq);
  state.markerByChat[chat.id] = {
    seq,
    updatedAt: new Date().toISOString(),
    by: state.config.userId || 'local',
  };

  persistLocalState();
  renderChatList();
  renderSelectedChat();

  if (isCloudEnabled()) {
    pushMarkerToCloud(chat.id, seq).catch(console.error);
  }
}

function jumpToMarker() {
  const chat = getSelectedChat();
  if (!chat) return;
  const marker = state.markerByChat[chat.id];
  if (!marker) return;

  const target = ui.messages.querySelector(`.message-row[data-seq="${marker.seq}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function supabaseRequest(path, options = {}) {
  const { supabaseUrl, supabaseKey } = state.config;
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Fehler: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function pushChatToCloud(chat) {
  await supabaseRequest('chats', {
    method: 'POST',
    body: JSON.stringify([
      {
        id: chat.id,
        title: chat.title,
        created_at: chat.createdAt,
      },
    ]),
  });

  const payload = chat.messages.map((m) => ({
    chat_id: chat.id,
    sequence: m.seq,
    sender: m.sender,
    text: m.text,
    sent_at: m.sentAt,
    media_name: m.mediaName || null,
    media_type: m.mediaType || null,
  }));

  await supabaseRequest('messages', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function pushMarkerToCloud(chatId, seq) {
  const body = [{
    chat_id: chatId,
    user_id: state.config.userId,
    last_sequence: seq,
    updated_at: new Date().toISOString(),
  }];

  await supabaseRequest('markers?on_conflict=chat_id,user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  });
}

async function loadMarkersFromCloud() {
  const userId = encodeURIComponent(`eq.${state.config.userId}`);
  const data = await supabaseRequest(`markers?user_id=${userId}&select=chat_id,last_sequence,updated_at`);

  for (const row of data || []) {
    state.markerByChat[row.chat_id] = {
      seq: row.last_sequence,
      updatedAt: row.updated_at,
      by: state.config.userId,
    };
  }

  persistLocalState();
}

async function syncAllToCloud() {
  for (const chat of state.chats) {
    await pushChatToCloud(chat).catch(() => {});
  }
}

async function deleteChatInCloud(chatId) {
  const idFilter = encodeURIComponent(`eq.${chatId}`);
  await supabaseRequest(`chats?id=${idFilter}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}
