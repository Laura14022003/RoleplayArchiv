const storageKey = 'rp-archiv-v1';
const mediaDbName = 'rp-media-db';
const mediaStoreName = 'media_assets';
const mediaDbVersion = 1;
const state = {
  chats: [],
  selectedChatId: null,
  markerByChat: {},
  sessionMediaByChat: {},
  mediaLoadInFlight: {},
};

const mediaDbPromise = openMediaDb();

const ui = {
  chatFileInput: document.getElementById('chatFileInput'),
  archiveFileInput: document.getElementById('archiveFileInput'),
  exportArchiveBtn: document.getElementById('exportArchiveBtn'),
  chatList: document.getElementById('chatList'),
  chatTitle: document.getElementById('chatTitle'),
  chatMeta: document.getElementById('chatMeta'),
  messages: document.getElementById('messages'),
  messageTemplate: document.getElementById('messageTemplate'),
  jumpMarkerBtn: document.getElementById('jumpMarkerBtn'),
  toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
  sidebar: document.getElementById('sidebar'),
};

boot().catch(console.error);

async function boot() {
  loadLocalState();
  bindEvents();
  renderChatList();
  if (state.chats.length > 0) {
    await selectChat(state.chats[0].id);
  } else {
    renderSelectedChat();
  }
}

function bindEvents() {
  ui.chatFileInput.addEventListener('change', handleImportFile);
  ui.archiveFileInput.addEventListener('change', handleArchiveImportFile);
  ui.exportArchiveBtn.addEventListener('click', exportArchiveFile);
  ui.jumpMarkerBtn.addEventListener('click', jumpToMarker);
  ui.toggleSidebarBtn.addEventListener('click', () => {
    ui.sidebar.classList.toggle('open');
  });
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

  const now = new Date().toISOString();
  const chat = {
    id: crypto.randomUUID(),
    title: file.name.replace(/\.txt$/i, ''),
    createdAt: now,
    updatedAt: now,
    messages,
  };

  await addChatToState(chat);
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

  const now = new Date().toISOString();
  const chat = {
    id: chatId,
    title: file.name.replace(/\.zip$/i, ''),
    createdAt: now,
    updatedAt: now,
    messages,
  };

  state.sessionMediaByChat[chat.id] = mediaIndex;
  await addChatToState(chat);
}

async function addChatToState(chat) {
  state.chats.unshift(chat);
  persistLocalState();
  renderChatList();
  await selectChat(chat.id);
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
  }

  return mediaIndex;
}

function isImageFile(fileName) {
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(fileName);
}

function parseWhatsAppExport(content, mediaIndex) {
  const lines = content.split(/\r?\n/);
  const messages = [];
  const pattern = /^(?:\u200e|\u200f)?(?:\[)?(\d{1,2}[./]\d{1,2}[./]\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s(?:-\s)?([^:]+):\s([\s\S]*)$/;
  let current = null;

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      const [, datePart, timePart, senderRaw, text] = match;
      current = {
        sender: senderRaw.trim(),
        text: (text || '').trim(),
        sentAt: parseLocalDate(datePart, timePart),
      };
      messages.push(current);
      continue;
    }

    if (current) {
      current.text += `\n${line}`;
    }
  }

  return messages.map((message, index) => enrichMessageWithMedia(message, index + 1, mediaIndex));
}

function enrichMessageWithMedia(message, seq, mediaIndex) {
  const mediaName = extractMediaReference(message.text);
  if (!mediaName) {
    return { ...message, seq };
  }

  return {
    ...message,
    seq,
    text: cleanupMediaDisplayText(message.text, mediaName),
    mediaName,
    mediaType: inferMediaType(mediaName),
    hasMedia: Boolean(resolveMediaUrl(mediaName, mediaIndex)),
  };
}

function extractMediaReference(text) {
  if (!text) return null;

  const clean = text.replace(/[\u200e\u200f]/g, '');
  const matches = [
    clean.match(/<(?:Anhang|attached):\s*([^>]+)>/i),
    clean.match(/(?:\bDatei angeh[aä]ngt:\s*|\bFile attached:\s*)([^\n]+)/i),
    clean.match(/\b([A-Z]{3}-\d{8}-WA\d{4}\.[a-z0-9]{3,5})\b/i),
    clean.match(/\b([^\s<>:"/\\|?*]+\.(?:jpe?g|png|gif|webp|bmp|heic|heif))\b/i),
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return match[1].replace(/[\u200e\u200f]/g, '').trim();
    }
  }

  return null;
}

function cleanupMediaMarkerText(text, mediaName) {
  let cleaned = text.replace(/[\u200e\u200f]/g, '');
  cleaned = cleaned.replace(new RegExp(`<\\s*(?:Anhang|attached):\\s*${escapeRegExp(mediaName)}\\s*>`, 'i'), '');
  cleaned = cleaned.replace(/\((?:Datei angeh[aä]ngt|File attached)\)/gi, '');
  cleaned = cleaned.replace(/(?:Datei angeh[aä]ngt:|File attached:)\s*[^\n]+/gi, '');
  cleaned = cleaned.replace(/\b(?:Anhang ausgelassen|Media omitted)\b/gi, '');
  cleaned = cleaned.replace(/^[\s,-]+|[\s,-]+$/g, '');
  return cleaned.trim();
}

function cleanupMediaDisplayText(text, mediaName) {
  const cleaned = cleanupMediaMarkerText(text, mediaName);
  if (!cleaned) return '';

  return cleaned
    .replace(/[\u200e\u200f]/g, '')
    .replace(new RegExp(`^${escapeRegExp(mediaName)}(?:\\s*\\n+|\\s*$)`, 'i'), '')
    .replace(new RegExp(`(^|[\\s\\n])${escapeRegExp(mediaName)}(?=[\\s\\n]|$)`, 'gi'), '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s,-]+|[\s,-]+$/g, '')
    .trim();
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
  return String(value || '').replaceAll('\\', '/').trim().toLowerCase();
}

function basename(path) {
  return String(path || '').replaceAll('\\', '/').split('/').pop() || path;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLocalDate(datePart, timePart) {
  const dateParts = datePart.split(/[./]/).map((n) => parseInt(n, 10));
  let [day, month, year] = dateParts;
  if (year < 100) year += 2000;

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
    openBtn.querySelector('p').textContent = markerSeq ? `Marker bei #${markerSeq}` : '';
    openBtn.addEventListener('click', async () => {
      await selectChat(chat.id);
      if (window.innerWidth <= 860) {
        ui.sidebar.classList.remove('open');
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'chat-delete';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', () => {
      deleteChat(chat.id).catch(console.error);
    });

    item.appendChild(openBtn);
    item.appendChild(deleteBtn);
    ui.chatList.appendChild(item);
  }
}

async function deleteChat(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;

  if (!window.confirm(`Chat "${chat.title}" wirklich löschen?`)) {
    return;
  }

  cleanupSessionMedia(chatId);
  await deletePersistedMediaForChat(chatId).catch(console.error);
  delete state.markerByChat[chatId];
  state.chats = state.chats.filter((entry) => entry.id !== chatId);

  if (state.selectedChatId === chatId) {
    state.selectedChatId = state.chats[0]?.id || null;
  }

  persistLocalState();
  renderChatList();

  if (state.selectedChatId) {
    await selectChat(state.selectedChatId);
  } else {
    renderSelectedChat();
  }
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

async function selectChat(chatId) {
  state.selectedChatId = chatId;
  renderChatList();
  renderSelectedChat();
  await ensureChatMediaLoaded(chatId);
  if (state.selectedChatId === chatId) {
    renderSelectedChat();
  }
}

function getSelectedChat() {
  return state.chats.find((chat) => chat.id === state.selectedChatId) || null;
}

function renderSelectedChat() {
  const chat = getSelectedChat();
  ui.messages.innerHTML = '';

  if (!chat) {
    ui.chatTitle.textContent = 'Kein Chat ausgewählt';
    ui.chatMeta.textContent = 'Importiere einen WhatsApp Export (.txt oder .zip)';
    ui.jumpMarkerBtn.disabled = true;
    return;
  }

  ui.chatTitle.textContent = chat.title;
  ui.chatMeta.textContent = `${chat.messages.length} Nachrichten`;
  ui.jumpMarkerBtn.disabled = !state.markerByChat[chat.id];

  const marker = state.markerByChat[chat.id];
  let me = null;

  for (const msg of chat.messages) {
    if (!me) me = msg.sender;

    const clone = ui.messageTemplate.content.firstElementChild.cloneNode(true);
    clone.classList.add(msg.sender === me ? 'out' : 'in');
    clone.dataset.seq = String(msg.seq);
    const markerBtn = clone.querySelector('.marker-toggle');
    const isMarked = marker?.seq === msg.seq;
    markerBtn.innerHTML = isMarked ? '&#128204;' : '&#128392;';
    markerBtn.classList.toggle('active', isMarked);
    markerBtn.setAttribute('aria-pressed', isMarked ? 'true' : 'false');
    markerBtn.setAttribute('aria-label', isMarked ? 'Marker gesetzt' : 'Marker setzen');
    markerBtn.title = isMarked ? 'Marker gesetzt' : 'Marker setzen';
    markerBtn.addEventListener('click', () => saveMarkerAtMessageSeq(msg.seq));
    clone.querySelector('.sender').textContent = msg.sender;
    renderFormattedMessage(clone.querySelector('.text'), msg.text || '');
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
    const missing = document.createElement('p');
    missing.className = 'media-missing';
    missing.textContent = '[Bild nicht mehr vorhanden]';
    bubbleNode.insertBefore(missing, bubbleNode.querySelector('.text'));
    return;
  }

  const img = document.createElement('img');
  img.className = 'media-image';
  img.src = url;
  img.alt = 'Chatbild';
  img.loading = 'lazy';
  bubbleNode.insertBefore(img, bubbleNode.querySelector('.text'));
}

function renderFormattedMessage(target, text) {
  target.innerHTML = formatMessageText(text);
}

function formatMessageText(text) {
  const codeTokens = [];
  let html = escapeHtml(text || '');

  html = html.replace(/```([\s\S]+?)```/g, (_, content) => {
    const token = `@@CODETOKEN${codeTokens.length}@@`;
    codeTokens.push(`<span class="text-code">${content}</span>`);
    return token;
  });

  html = html.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  for (let i = 0; i < codeTokens.length; i += 1) {
    html = html.replace(`@@CODETOKEN${i}@@`, codeTokens[i]);
  }

  return html;
}

function formatTime(iso) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function saveMarkerAtMessageSeq(seq) {
  const chat = getSelectedChat();
  if (!chat || !seq) return;

  state.markerByChat[chat.id] = {
    seq,
    updatedAt: new Date().toISOString(),
    by: 'local',
  };

  persistLocalState();
  renderChatList();
  renderSelectedChat();
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

async function clearPersistedMedia() {
  const db = await mediaDbPromise;
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(mediaStoreName, 'readwrite');
    const store = tx.objectStore(mediaStoreName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
  });
}

async function listPersistedMediaRecords() {
  const db = await mediaDbPromise;
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(mediaStoreName, 'readonly');
    const store = tx.objectStore(mediaStoreName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function loadLocalState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    state.chats = Array.isArray(parsed.chats) ? parsed.chats : [];
    state.markerByChat = parsed.markerByChat || {};
  } catch {
    state.chats = [];
    state.markerByChat = {};
  }
}

function persistLocalState() {
  localStorage.setItem(storageKey, JSON.stringify({
    chats: state.chats,
    markerByChat: state.markerByChat,
  }));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function exportArchiveFile() {
  const mediaRecords = await listPersistedMediaRecords();
  const mediaAssets = [];

  for (const record of mediaRecords) {
    if (!record?.blob || !record?.chatId || !record?.mediaKey) continue;
    mediaAssets.push({
      chatId: record.chatId,
      mediaKey: record.mediaKey,
      dataUrl: await blobToDataUrl(record.blob),
    });
  }

  const archive = {
    version: 1,
    exportedAt: new Date().toISOString(),
    chats: state.chats,
    markerByChat: state.markerByChat,
    mediaAssets,
  };

  const fileName = `roleplay-archiv-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function handleArchiveImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const raw = JSON.parse(await file.text());
    const chats = Array.isArray(raw.chats) ? raw.chats : [];
    const markerByChat = raw.markerByChat || {};
    const mediaAssets = Array.isArray(raw.mediaAssets) ? raw.mediaAssets : [];

    for (const chatId of Object.keys(state.sessionMediaByChat)) {
      cleanupSessionMedia(chatId);
    }

    await clearPersistedMedia();
    for (const asset of mediaAssets) {
      if (!asset?.chatId || !asset?.mediaKey || !asset?.dataUrl) continue;
      const response = await fetch(asset.dataUrl);
      const blob = await response.blob();
      await persistMediaBlob(asset.chatId, asset.mediaKey, blob);
    }

    state.chats = chats;
    state.markerByChat = markerByChat;
    state.selectedChatId = chats[0]?.id || null;
    persistLocalState();
    renderChatList();

    if (state.selectedChatId) {
      await selectChat(state.selectedChatId);
    } else {
      renderSelectedChat();
    }
  } catch (error) {
    console.error(error);
    alert(`Archiv-Import fehlgeschlagen: ${error.message}`);
  } finally {
    ui.archiveFileInput.value = '';
  }
}
