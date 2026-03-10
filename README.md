# RoleplayArchiv

Private, mobilefreundliche Archiv-Webseite fuer WhatsApp-Roleplay-Chats.

## Was dieses MVP kann
- WhatsApp-Export (`.txt` oder `.zip`) importieren und als Chat anzeigen
- Bei `.zip`: Bilder aus dem Export direkt in den Nachrichten anzeigen
- Bilder lokal persistent speichern (bleiben nach Reload/Neustart erhalten)
- Lesemarker pro Chat setzen (`Hier weiterlesen`) und spaeter anspringen
- Chats wieder loeschen
- Komplettes Archiv als JSON exportieren und auf einem anderen Geraet wieder importieren
- Funktioniert komplett lokal ohne Server, Login oder Zusatzkosten

## Dateien
- `index.html` - UI-Struktur
- `index.html` - UI-Struktur und eingebettetes Design
- `app.js` - Import, Parser, Archivlogik, Marker und Export/Import

## Schnellstart
1. Repo oeffnen.
2. `index.html` im Browser starten.
3. `Chat importieren` anklicken und einen WhatsApp-Export (`.txt` oder `.zip`) waehlen.

## Einfachster gemeinsamer Weg
Wenn ihr beide denselben Stand lesen wollt:

1. Auf einem Geraet Chats importieren.
2. `Archiv exportieren` klicken.
3. Die erzeugte JSON-Datei an das andere Geraet schicken oder in einen geteilten Ordner legen.
4. Dort `Archiv importieren`.

Das ist komplett kostenlos, aber nicht automatisch live synchronisiert.

## WhatsApp-Export erstellen
1. In WhatsApp den Chat oeffnen.
2. `Mehr` -> `Chat exportieren`.
3. Fuer Bildanzeige `Mit Medien` exportieren (`.zip`).
4. ZIP oder TXT hier importieren.

## Naechste Ausbaustufen
- Volltextsuche ueber alle Roleplays
- Kapitel/Tags/Favoriten pro Nachricht
- PDF-Import fuer alte Screenshot-Dokumente
