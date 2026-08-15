# RDP mimarisi — Faz 0 keşif notları

Kaynak: repo `main` @ 2dce1b8. Tüm satır numaraları o commit'e göredir.

---

## 0. Ön bilgi doğrulaması

| İddia                                         | Durum                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22 + Express 5, `ws`                     | ✔ `package.json` `engines.node >=22.12.0`, `express ^5.2.1`, `ws ^8.21.1`                                                                       |
| `guacamole-lite` → ayrı `guacd` konteyneri    | ✔ `guacamole-lite ^1.2.0`; `docker/docker-compose.yml:21` `image: guacamole/guacd:1.6.0`                                                        |
| Feature-modular backend                       | ✔ ama **modüller Express router değil, kendi portunda ayrı WS/HTTP sunucusu**. Detay §1                                                         |
| better-sqlite3 + Drizzle, üç DB               | ✔ ama migration akışı dialect'e göre farklı. Detay §5                                                                                           |
| `electron/` standalone backend                | ✔ — fakat **guacd bundle edilmiyor**; RDP/VNC/Telnet Electron'da zorunlu olarak uzak sunucuya gidiyor (`src/ui/lib/connection-origin.ts:20-32`) |
| Biome/Prettier/ESLint/Vitest/commitlint/Husky | ✔                                                                                                                                               |
| Crowdin ~30 dil                               | ✔ `src/ui/locales/en.json` kaynak + `src/ui/locales/translated/*.json`                                                                          |
| Apache 2.0                                    | ✔ `LICENSE`                                                                                                                                     |

Darboğaz teşhisi de doğru: kodda hiçbir yerde codec pass-through yok. Backend guacd'ye
sadece bir TCP soketi açıyor (`guacamole-lite` içinde) ve Guacamole protokolü instruction'larını
WebSocket'e relay ediyor. Karo/PNG üretimi tamamen guacd tarafında.

---

## 1. Backend modül kaydı

**Yükleme noktası:** `src/backend/starter.ts:212-222` — düz `await import()` listesi:

```
./hosts/terminal/index.js      → WS :30002
./hosts/tunnel/index.js        → :30003
./hosts/file-manager/index.js  → WS :30004
./hosts/metrics/index.js       → :30005
./hosts/docker/index.js        → :30007
./hosts/docker/console.js      → WS :30009
./hosts/tmux/index.js
./hosts/serial.js              → WS :30011
./services/dashboard.js        → :30006
./services/homepage.js         → :30012
```

Guacamole ayrı ve **koşullu** yükleniyor — `src/backend/starter.ts:234-253`:
`ENABLE_GUACAMOLE !== "false"` **ve** DB'deki `guac_enabled` ayarı `"false"` değilse
`./hosts/guacamole/guacamole-server.js` import ediliyor; import hatası yutuluyor
(guacd yoksa uygulama ayakta kalıyor). Bu, yeni bir render yolu için taklit edilecek desen.

**REST tarafı ayrı:** ana Express app `src/backend/database/database.ts:64`,
router'lar `1733-1753` arası mount ediliyor (`app.use("/guacamole", guacamoleRoutes)` → `:1741`),
HTTP portu `src/backend/database/database.ts:1830` = **30001**.

**Yeni bir protokol modülü eklemek için dokunulacaklar:**

1. `src/backend/hosts/<yeni>/` dizini (`index.ts` kendi WS server'ını `new WebSocketServer({ port })` ile açar)
2. `src/backend/starter.ts` — import satırı (koşulluysa guacamole bloğu deseni)
3. `src/backend/database/database.ts` — REST router mount'u (token/handshake endpoint'i gerekiyorsa)
4. `docker/Dockerfile:85` — `EXPOSE` port listesi
5. `docker/nginx.conf` + `docker/nginx-https.conf` — WS için `location ^~ /<yol>/websocket/` bloğu
   (`nginx.conf:465-488` guacamole örneği)
6. `src/backend/utils/swagger.ts` — yeni port için server girişi (opsiyonel)

---

## 2. RDP akışının tam zinciri

Kullanıcı tıklamasından piksele:

| #   | Adım                                                                                      | Dosya : satır                                                                                                |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Sidebar'da host'un RDP butonu → `onOpenTab(host, "rdp")`                                  | `src/ui/sidebar/SidebarTree.tsx:559`, `:773`, `:1143`, `:1262`                                               |
| 2   | Tab tipi çözümleme (`enableRdp` kapalıysa fallback)                                       | `src/ui/lib/host-connection-tabs.ts:24-40`, çağrısı `src/ui/AppShell.tsx:1184`                               |
| 3   | Tab içeriği render — `rdp`/`vnc`/`telnet` üçü de aynı component                           | `src/ui/shell/tabUtils.tsx:380-395` (lazy import `:67-71`), portal `src/ui/AppShell.tsx:2099`                |
| 4   | Host konfigürasyonunu çek (`getSSHHosts`)                                                 | `src/ui/features/guacamole/GuacamoleApp.tsx:64-71`                                                           |
| 5   | guacd erişilebilir mi? `GET /guacamole/status`                                            | `GuacamoleApp.tsx:199-203` → `src/backend/hosts/guacamole/routes.ts:705-761`                                 |
| 6   | `POST /guacamole/connect-host/:hostId` → şifreli token                                    | `GuacamoleApp.tsx:204-211` → `src/ui/api/guacamole-api.ts` → `src/backend/hosts/guacamole/routes.ts:206-699` |
| 6a  | RBAC kontrolü                                                                             | `routes.ts:229-245`                                                                                          |
| 6b  | Credential çözümleme (paylaşılan host / credential / direct)                              | `routes.ts:316-433`                                                                                          |
| 6c  | Jump host varsa geçici SSH tüneli, guacd'ye tünel portu verilir                           | `routes.ts:491-568`                                                                                          |
| 6d  | Kayıt (recording) parametreleri                                                           | `routes.ts:578-601`, `recording-settings.ts`                                                                 |
| 6e  | AES-256-CBC token üretimi                                                                 | `token-service.ts:144-175` (`createRdpToken`)                                                                |
| 6f  | guacd handshake'inin açılmasını bekle (10 sn), `guacamoleConnectionId` döndür             | `routes.ts:673`, `guacamole-server.ts:61-80`                                                                 |
| 7   | `<GuacamoleDisplay>` mount → WS URL kur                                                   | `GuacamoleApp.tsx:405-419`, `GuacamoleDisplay.tsx:137-219`                                                   |
| 8   | WS base URL seçimi (dev / electron / nginx arkası)                                        | `src/ui/features/guacamole/guacamole-websocket-url.ts:1-31`                                                  |
| 9   | `Guacamole.WebSocketTunnel` + `Guacamole.Client`                                          | `GuacamoleDisplay.tsx:365-366`                                                                               |
| 10  | `client.connect(query)` — query: `token`, `width`, `height`, `dpi`                        | `GuacamoleDisplay.tsx:589`, params `:206-212`                                                                |
| 11  | nginx `/guacamole/websocket/` → `127.0.0.1:30008`                                         | `docker/nginx.conf:465-488`, `nginx-https.conf:485-508`                                                      |
| 12  | `guacamole-lite` WS sunucusu, token'ı çözer, guacd'ye bağlanır                            | `src/backend/hosts/guacamole/guacamole-server.ts:196-262`, port `:23` = 30008                                |
| 13  | guacd (ayrı konteyner, `:4822`) FreeRDP ile hedefe bağlanır, PNG/JPEG/WebP karoları döner | `resolveGuacdOptions` → `src/backend/utils/guacd-config.ts:66-77`                                            |
| 14  | Tarayıcı: `client.getDisplay()` → canvas DOM'a eklenir                                    | `GuacamoleDisplay.tsx:375`, `:286`                                                                           |

Not: `POST /guacamole/token` (`routes.ts:80-146`) host'suz, serbest parametreli ikinci bir
token endpoint'i — `GuacamoleDisplay.tsx:150-169`'daki `connectionConfig.token` yoksa kullanılan yol.
Normal host akışında kullanılmıyor.

---

## 3. `connectionDefaultSettings`

`src/backend/hosts/guacamole/guacamole-server.ts:161-186` — `guacamole-lite`'a verilen
`clientOptions` içinde, protokol başına varsayılanlar:

```
rdp:    security "any", ignore-cert true, enable-wallpaper false,
        enable-font-smoothing true, enable-desktop-composition false,
        disable-audio false, enable-drive false,
        resize-method "display-update", 1280x720, dpi 96, audio ["audio/L16"]
vnc:    swap-red-blue false, cursor "remote", 1280x720
telnet: terminal-type "xterm-256color"
```

**Override zinciri (soldan sağa, sağdaki kazanır):**

1. `connectionDefaultSettings` (yukarıdaki, `guacamole-server.ts:161`)
2. `createRdpToken` içindeki sabitler — `port: 3389`, `ignore-cert: true`,
   kullanıcı/parola yoksa `disable-auth: true` (`token-service.ts:156-173`)
3. Host kolonlarından: `rdpSecurity`, `rdpIgnoreCert` (`routes.ts:624-633`)
4. **`host.guacamoleConfig`** — host başına JSON, `routes.ts:276-298`'de parse edilir,
   `"auto"` sentinel değerleri silinir, `routes.ts:634` ile spread edilir. Bu, faz 3'te
   yeni RDP parametrelerini (örn. `disable-gfx`, `force-lossless`) sokmanın doğal yeri.
   UI karşılığı: `src/ui/sidebar/HostEditorGuacamoleTabs.tsx`, tip listesi
   `src/ui/api/guacamole-api.ts` `GuacamoleTokenRequest.guacamoleConfig`
5. Per-connection guacd hedefi: `guacd-hostname` / `guacd-port` `guacamoleConfig`'ten
   çıkarılıp ayrı geçirilir (`routes.ts:300-308`, `:570-577`)
6. `allowedUnencryptedConnectionSettings` (`guacamole-server.ts:156-160`): sadece
   `width`, `height`, `dpi` (rdp) query string'den şifresiz kabul edilir — tarayıcının
   gerçek boyutu buradan geçiyor (`GuacamoleDisplay.tsx:206-212`)

---

## 4. Protokol tipi nasıl tanımlı?

**Tek bir kaynak yok.** Dört ayrı yerde tekrar eden string literal union + DB'de kolonlar:

- `src/types/index.ts:67` — `export type ConnectionType = "ssh" | "rdp" | "vnc" | "telnet"`
- `src/types/ui-types.ts:241-257` — `TabType` (rdp/vnc/telnet ayrı üye)
- `src/backend/hosts/guacamole/token-service.ts:5` — `type?: "rdp" | "vnc" | "telnet"`
- `src/ui/features/guacamole/GuacamoleDisplay.tsx:26` — `GuacamoleConnectionType`
- DB: `ssh_data.connection_type TEXT` (varsayılan `'ssh'`) **artı** protokol başına
  `enable_ssh` / `enable_rdp` / `enable_vnc` / `enable_telnet` boolean kolonları
  (`src/backend/database/db/schema.ts:211-214`). Yani modern akış `connectionType`'ı değil
  `enableX` bayraklarını kullanıyor; `connectionType` geriye dönük uyumluluk için duruyor
  (migration fallback: `routes.ts:257-269`, `host-normalizers.ts:432-438`).

Ayrıca runtime doğrulaması **string dizisi** olarak elde tekrarlanıyor:
`routes.ts:97`, `:251`, `session-sharing/routes.ts:180`.

### Yeni protokol tipi için dokunulacak dosyaların tam listesi

**Tip/şema:**

- `src/types/index.ts` (`ConnectionType`, `SSHHost` alanları — `:67`, `:187`, `:312`, `:711`)
- `src/types/ui-types.ts` (`TabType` `:241`, `Host` `enableX` `:156-158`)
- `src/backend/database/db/schema.ts` (`hosts` tablosu `:118-280`)
- `src/backend/database/db/index.ts` (SQLite DDL `:285`+ ve `sshDataMigrations` dizisi `:1515`)
- `scripts/generate-dialect-schema.cjs` çıktıları: `schema.pg.ts`, `schema.mysql.ts`
  (**elle düzenleme, `npm run schema:generate`**) + `drizzle/postgres`, `drizzle/mysql` migration'ları

**Backend:**

- `src/backend/database/routes/host.ts` (create `:221`,`:359-368`; update `:872`,`:1007-1016`; get `:1739`)
- `src/backend/database/routes/host-normalizers.ts` (`:186`, `:198`, `:243-246`, `:332`, `:432-438`)
- `src/backend/database/routes/host-bulk-routes.ts` (import/export `:603`, `:628`, `:851`)
- `src/backend/hosts/guacamole/routes.ts` — sadece guacd yolu içinse
- `src/backend/hosts/session-sharing/routes.ts:180` (protokol whitelist'i)
- `src/backend/utils/analytics.ts`, `src/backend/services/dashboard.ts` (sayaçlar)
- `src/backend/utils/shared-host-secrets-manager.ts` + `shared-host-auth-resolver.ts`
  - `repositories/shared-host-secrets-repository.ts` (host paylaşımı yapılacaksa)

**Frontend:**

- `src/ui/shell/tabUtils.tsx` (`tabIcon` `:165`, `renderTabContent` `:286`)
- `src/ui/lib/host-connection-tabs.ts` (tamamı)
- `src/ui/AppShell.tsx` (`:960` restore filtresi, `:1184`, `:1231`, `:1802`)
- `src/ui/sidebar/SidebarTree.tsx` (protokol rozetleri + açma butonları — ~10 nokta)
- `src/ui/sidebar/HostEditor.tsx`, `HostEditorData.ts`, `HostEditorFeatureTabs.tsx`,
  `HostEditorGuacamoleTabs.tsx`, `HostManagerData.ts`, `HostManagerTabs.tsx`, `HostsPanel.tsx`
- `src/ui/shell/CommandPalette.tsx` (`:383`, `:443-448`), `Tab.tsx`, `TabBar.tsx`
- `src/ui/features/homepage/widgets/QuickConnectWidget.tsx:45` + `RecentActivityWidget.tsx`
- `src/ui/lib/connection-origin.ts:20-32` (Electron local/remote kararı)
- `src/ui/locales/en.json` (yeni anahtarlar; çeviriler Crowdin'den gelir)

---

## 5. Host şeması ve şifreleme

**Drizzle tanımı:** `src/backend/database/db/schema.ts:118-280` — tablo adı `ssh_data`.
İlgili kolonlar: `:211-238` (enable bayrakları, portlar, `rdp_user/password/domain/security`,
`*_credential_id`, `*_auth_type`), `:243` `guacamole_config TEXT`.

**Dialect'e göre şema akışı — dikkat, üçü aynı değil:**

- **SQLite:** drizzle migration kullanmıyor. Şema `src/backend/database/db/index.ts:285`'teki
  ham DDL'den kuruluyor, sonra `migrateSchema()` (`:789`, çağrısı `:719`) ile ileri taşınıyor.
  Yeni kolon = `sshDataMigrations` dizisine (`:1515`) `ALTER TABLE ... ADD COLUMN` satırı.
- **Postgres / MySQL:** `drizzle/postgres`, `drizzle/mysql` altındaki drizzle-kit migration'ları
  (`src/backend/database/db/migrate.ts:31-51`). Şu an her dialect'te tek `0000_*` baseline var.
  `npm run schema:migrations` üç dialect için de generate ediyor.
- `schema.pg.ts` / `schema.mysql.ts` **üretilmiş dosyalar** — `scripts/generate-dialect-schema.cjs`
  bunları `schema.ts`'ten türetiyor; sadece DDL için, runtime'da 44 repository `schema.ts`'i
  import ediyor. `npm run lint` bu üretimin güncelliğini `--check` ile doğruluyor, yani
  `schema.ts`'i elle değiştirip generate etmezsen lint kırılır.

**Field-level encryption:**

- Alan listesi: `src/backend/utils/field-crypto.ts:17-48` — `ssh_data` için
  `password, key, keyPassword, sudoPassword, autostartPassword, autostartKey,
autostartKeyPassword, socks5Password, rdpPassword, vncPassword, telnetPassword`.
  **Yeni bir sır kolonu eklersen bu Set'e eklemek zorunlusun** — aksi halde düz metin yazılır.
- Algoritma: AES-256-GCM, alan anahtarı HKDF-SHA256 ile `${recordId}:${fieldName}` context'inden
  türetiliyor (`field-crypto.ts:50-84`), yani kayıt kimliğine bağlı.
- Orkestrasyon: `src/backend/utils/data-crypto.ts` (`encryptRecordForUser:256`,
  `decryptRecordForUser:265`), kullanıcı DEK'i `UserKeyManager` (`utils/user-keys.ts`).
- Eski düz metinden geçiş: `utils/lazy-field-encryption.ts` + `data-crypto.ts:84-215`.
- Paylaşılan host'ta alıcı sahibin sırlarını **hiç görmez**; per-recipient snapshot
  `SharedHostSecretsManager` üzerinden çözülür (`guacamole/routes.ts:320-360`).

---

## 6. Yetkilendirme

**REST:** `src/backend/hosts/guacamole/routes.ts:30` — router'ın tamamı
`AuthManager.createAuthMiddleware()` arkasında. Host erişimi ayrıca
`PermissionManager.canAccessHost(userId, hostId, "connect")` ile kontrol ediliyor
(`routes.ts:229-245` → `src/backend/utils/permission-manager.ts:168-249`): sahiplik →
rol/kullanıcı bazlı `host_access` grant'i → seviye karşılaştırması → admin bypass.

**WebSocket — burada bir asimetri var:**

- Terminal WS (`:30002`) kendi JWT doğrulamasını yapıyor:
  `src/backend/hosts/terminal/index.ts:270-334` — cookie `jwt=` → `Authorization: Bearer` →
  `?token=` sırasıyla arar, `authManager.verifyJWTToken()`, sonra `DataCrypto.getUserDataKey()`
  ile "data locked" kontrolü (`:336-347`). **Yeni WS endpoint'i için kopyalanacak desen budur.**
- Guacamole WS (`:30008`) **JWT görmez.** Tek yetki kanıtı, kimliği doğrulanmış REST
  çağrısında üretilmiş AES-256-CBC token'dır (`token-service.ts:107-124`). Token'da
  expiry, nonce veya userId bağı yok; anahtar `GUACAMOLE_ENCRYPTION_KEY` yoksa
  `sha256(JWT_SECRET + "_guacamole")` (`token-service.ts:75-101`).

Yeni bir WS endpoint'i açarken doğru yol: terminal desenini kullan (JWT doğrula +
`PermissionManager.canAccessHost`), guacamole'ün token-only modelini kopyalama.

---

## 7. Session sharing — kritik bulgu

**İki ayrı mekanizma var, ve RDP tarafı tamamen guacd'ye bağımlı:**

- **SSH:** Termix kendi çözüyor. `sessionManager` canlı oturumu tutuyor, katılımcılar
  aynı Termix WS'ine bağlanıyor (`hosts/terminal/session-manager.ts`,
  `session-sharing/routes.ts:95-97`). Guest'ler için anonim `?shareToken=` yolu bile var
  (`terminal/index.ts:134-169`). Zorla atma (kick) mümkün.
- **RDP/VNC/Telnet:** **guacd'nin çok kullanıcılı `join` özelliğine dayanıyor.**
  - Birincil bağlantı açıldığında guacd'nin kendi `guacamoleConnectionId`'si yakalanıp
    map'e yazılıyor (`guacamole-server.ts:204-228`).
  - Paylaşım isteğinde `createJoinToken(guacamoleConnectionId, readOnly)`
    (`token-service.ts:241-250`) — bu token guacd'ye `join` instruction'ı olarak gidiyor;
    read-only bayrağını da guacd uyguluyor.
  - `session-sharing/routes.ts:453-458`.
  - Yorum satırı açıkça söylüyor: `routes.ts:363` — _"guac joins aren't force-kickable"_.
    Yani guacd yolunda revoke sadece yeni katılımı engelliyor, canlı guest'i düşürmüyor.

**Faz 2/3 için sonuç:** guacd'yi devre dışı bırakan her yolda oturum paylaşımı
**sıfırdan yazılmak zorunda.** WebRTC yolunda (Faz 2) medya Termix üzerinden geçmediği için
sunucu tarafında fan-out yapılamaz — paylaşım ya hedefteki yayıncının çok-izleyici desteğine
kalır ya da hiç olmaz. Faz 3'te (H.264 pass-through) aynı NAL akışını N WebSocket'e
kopyalamak teknik olarak mümkün ama girdi (klavye/fare) çakışması ve read-only zorlaması
Termix tarafında çözülmek zorunda. CLAUDE.md'nin "paylaşım çalışmıyorsa UI'da açıkça belirt"
talimatı bu yüzden yerinde.

Şema tarafı: `session_shares` tablosu protokolü serbest string tutuyor, whitelist
`session-sharing/routes.ts:180`'de. Yeni protokol eklenirse orası da güncellenmeli.

---

## 8. Frontend render katmanı

- `guacamole-common-js` **tek yerde** import ediliyor:
  `src/ui/features/guacamole/GuacamoleDisplay.tsx:9`. Tip tanımları
  `src/types/guacamole-common-js.d.ts`. Paket postinstall'da patch'leniyor
  (`scripts/patch-guacamole-common-js.cjs`).
- Canvas: kütüphane kendi DOM elemanını üretiyor, `client.getDisplay().getElement()`
  container'a ekleniyor (`GuacamoleDisplay.tsx:375`, `:286`). Yani canvas'ı Termix çizmiyor.
  Ölçekleme/DPI: `guacamole-display-size.ts`.
- **Lazy loading zaten var:** `tabUtils.tsx:67-71` — `GuacamoleApp` dynamic import.
  Yeni bir render yolu ayrı bir lazy chunk olarak eklenirse `guacamole-common-js`
  o yolda hiç yüklenmez (Faz 2 gereksinimi karşılanabilir).
- Protokole göre component seçimi: `tabUtils.tsx:286-430` içindeki `switch (tab.type)`;
  `rdp`/`vnc`/`telnet` üç case aynı `<GuacamoleApp>`'e düşüyor (`:380-395`).
  **Yeni protokol = bu switch'e yeni bir case.**
- Split-screen: `src/ui/shell/SplitView.tsx` sadece layout. İçerik `AppShell.tsx:2093-2110`'da
  `createPortal(renderTabContent(...))` ile pane'lere taşınıyor, `isVisible` bayrağı
  görünürlüğü component'e bildiriyor. Protokole özel bir şey yok — yeni tip otomatik uyumlu.
- Toolbar: `GuacamoleToolbar.tsx` (klavye kısayolları, touch modu, clipboard).
  Clipboard Firefox özel yolu: `guacamole-clipboard.ts`.

---

## 9. Test altyapısı

`vitest.config.ts` üç proje tanımlıyor:

| Proje      | Ortam | Kapsam                                                            |
| ---------- | ----- | ----------------------------------------------------------------- |
| `backend`  | node  | `src/backend/**/*.test.ts` — timeout `TEST_DIALECT` set ise 60 sn |
| `frontend` | jsdom | `src/ui/**/*.test.{ts,tsx}`                                       |
| `scripts`  | node  | `scripts/**/*.test.ts`                                            |

Setup: `vitest.setup.ts`. Alias: `@` → `src/ui`, `@/types` → `src/types`.

Mevcut guacamole testleri:

- `src/backend/tests/hosts/guacamole/token-service.test.ts` (şifreleme round-trip)
- `.../recording-settings.test.ts`, `.../jump-tunnel-endpoint.test.ts`
- `src/ui/tests/features/guacamole/GuacamoleDisplay.test.ts`,
  `guacamole-clipboard.test.ts`, `guacamole-display-size.test.ts`

Desen: **saf yardımcı fonksiyonlar test ediliyor, WS/guacd entegrasyonu edilmiyor.**
Yeni backend modülü testi → `src/backend/tests/hosts/<modül>/*.test.ts`.
Repository testleri `TEST_DIALECT` ile gerçek Postgres/MySQL'e de yönlendirilebiliyor.

---

## Faz 1 için dokunulması gereken dosyalar

Yeni `stream` protokol tipi (iframe embed) için:

**Şema (üç DB):**

1. `src/backend/database/db/schema.ts` — `hosts` tablosuna `enableStream`, `streamUrl`,
   `streamPath`, `streamCredentialId`/`streamUser`/`streamPassword`, `streamAuthType`
2. `src/backend/database/db/index.ts` — `sshDataMigrations` dizisine (`:1515`) ALTER satırları
3. `src/backend/utils/field-crypto.ts:25-37` — `streamPassword` → `ssh_data` Set'ine
4. `npm run schema:generate` → `schema.pg.ts`, `schema.mysql.ts`
5. `npm run schema:migrations` → `drizzle/postgres/`, `drizzle/mysql/` (sqlite klasörü
   runtime'da kullanılmıyor ama generate edilmesi tutarlılık için beklenir)

**Backend:** 6. `src/backend/database/routes/host.ts` — create/update/get alan geçişleri 7. `src/backend/database/routes/host-normalizers.ts` — normalize + `enableX` fallback mantığı 8. `src/backend/database/routes/host-bulk-routes.ts` — import/export 9. `src/backend/utils/shared-host-secrets-manager.ts` + `shared-host-auth-resolver.ts`

- `repositories/shared-host-secrets-repository.ts` — paylaşılan host'ta credential

10. `src/backend/hosts/session-sharing/routes.ts:180` — `stream` için paylaşım
    **desteklenmiyor** olarak bırakılacaksa whitelist'e eklenmez (bilinçli karar)

**Frontend:** 11. `src/types/index.ts`, `src/types/ui-types.ts` — `ConnectionType`, `TabType`, `Host` 12. `src/ui/lib/host-connection-tabs.ts` — `stream` case'leri 13. `src/ui/shell/tabUtils.tsx` — `tabIcon` + `renderTabContent` case + yeni lazy component 14. **Yeni:** `src/ui/features/stream/StreamApp.tsx` (iframe render) 15. `src/ui/sidebar/SidebarTree.tsx` — rozet + açma butonları 16. `src/ui/sidebar/HostEditor.tsx` / `HostEditorData.ts` / `HostEditorFeatureTabs.tsx`
(+ gerekirse yeni `HostEditorStreamTab.tsx`) 17. `src/ui/sidebar/HostManagerData.ts`, `HostManagerTabs.tsx`, `HostsPanel.tsx` 18. `src/ui/AppShell.tsx` — `:960` tab restore filtresi, `:1231`/`:1802` default host objeleri 19. `src/ui/shell/CommandPalette.tsx`, `src/ui/features/homepage/widgets/QuickConnectWidget.tsx` 20. `src/ui/lib/connection-origin.ts` — `stream` local mi remote mu (muhtemelen host override'ına bırakılır) 21. `src/ui/locales/en.json` — yeni i18n anahtarları

**Testler:** 22. `src/backend/tests/database/` — normalizer/repository testi 23. `src/ui/tests/features/stream/` — component testi

---

## Risk listesi — bu işte seni yakabilecek 5 şey

**1. Şema değişikliği üç yerde birden tutarlı olmak zorunda, ve lint bunu zorluyor.**
`schema.ts`'i değiştirip `npm run schema:generate` çalıştırmazsan `npm run lint` kırılır
(`generate-dialect-schema.cjs --check`). Daha kötüsü: SQLite `sshDataMigrations` dizisine
ALTER eklemeyi unutursan **yeni kurulumlar çalışır, mevcut kurulumlar sessizce "no such column"
ile patlar.** SQLite drizzle migration kullanmıyor — bu, klasörü görüp "migration yazdım"
sanmanın en kolay olduğu yer.

**2. Yeni sır kolonu `field-crypto.ts`'e eklenmezse düz metin diske yazılır.**
`ENCRYPTED_FIELDS.ssh_data` (`:25-37`) elle bakımlı bir Set. Şema tarafında `streamPassword`
kolonunu açıp burayı unutmak tip hatası vermez, test kırmaz, sadece parolayı açıkta bırakır.
Üstelik sonradan eklemek geriye dönük migration gerektirir (`lazy-field-encryption.ts` deseni).

**3. Session sharing sessizce kaybolur.** RDP paylaşımının tamamı guacd'nin `join`
özelliğine dayanıyor (`token-service.ts:241`, `guacamole-server.ts:204-228`). guacd'siz
her yolda paylaşım **yok**, ve mevcut UI paylaş butonunu protokole göre gizlemiyor —
`canShare()` sadece `guacamoleConnectionId !== null` bakıyor (`GuacamoleApp.tsx:169`).
Yeni yolda bunu açıkça devre dışı bırakmazsan kullanıcı paylaşım linki üretir, link çalışmaz.

**4. Electron standalone modu RDP'yi zaten uzak sunucuya pinliyor.**
`connection-origin.ts:23-29` — `rdp`/`vnc`/`telnet` koşulsuz `"remote"` dönüyor, çünkü
guacd bundle edilmiyor. Faz 2/3'te "artık guacd'ye gerek yok" dediğin anda bu kural yanlış
hale gelir ama kod hâlâ uzak sunucu zorunlu tutar; `getRemoteGuacamoleApi()` yönlendirmesi de
aynı varsayıma bağlı (`src/ui/api/guacamole-api.ts:9-17`). Bunu güncellemezsen yeni yol
masaüstü uygulamasında hiç çalışmaz; yanlış güncellersen mevcut guacd yolu bozulur.

**5. guacd yolunun WS katmanında JWT doğrulaması yok.**
`:30008` sadece şifreli token'a güveniyor; token'da expiry/nonce/userId bağı yok
(`token-service.ts:107-124`). Bunu "mevcut desen" sanıp yeni WebRTC/H.264 endpoint'inde
kopyalarsan, kimliği doğrulanmamış bir medya kanalı açmış olursun. Doğru referans
`terminal/index.ts:270-347`. Ayrıca `guacamole-lite` ve `guacamole-common-js` postinstall'da
patch'leniyor (`scripts/patch-guacamole-*.cjs`) — bu patch'lerin ne yaptığını bilmeden
sürüm yükseltmek mevcut yolu sessizce bozabilir.
