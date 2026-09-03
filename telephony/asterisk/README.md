# Asterisk gateway

Il gateway previsto è `sipcall Classic → Asterisk 22 in WSL2 → OpenAI Realtime SIP`. I file in questa cartella sono template senza credenziali: non sostituiscono automaticamente la configurazione live.

## Sequenza di collaudo

1. Conservare il dialplan live attuale e verificare una chiamata con `Playback(hello-world)`.
2. Solo dopo, provare `Echo()` per controllare l'audio bidirezionale.
3. Fare un backup dei file `/etc/asterisk/*.conf` interessati.
4. Integrare manualmente i blocchi OpenAI dai template, sostituendo `OPENAI_PROJECT_ID`.
5. Ricaricare PJSIP/dialplan e verificare TLS 5061, codec negoziato e RTP.
6. Infine testare webhook, sideband e ordine completo.

La destinazione OpenAI UE è `sip:OPENAI_PROJECT_ID@sip-eu.api.openai.com;transport=tls`. Il fallback locale deve riprodurre un messaggio e chiudere senza loop. Non registrare audio.

## Heartbeat

Installare `status-heartbeat.sh` come `/usr/local/bin/pizzer-ia-heartbeat` e `pizzer-ia-heartbeat.service` in `/etc/systemd/system/`. Conservare URL, token dedicato e intervallo in `/etc/pizzer-ia/heartbeat.env` con permessi `0600`; il token deve corrispondere a `HEARTBEAT_SECRET` del backend. Lo script invia ogni 25 secondi solo stato processo, registrazione, versione e timestamp; non invia credenziali SIP.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pizzer-ia-heartbeat
sudo systemctl status pizzer-ia-heartbeat
sudo journalctl -u pizzer-ia-heartbeat
```

L'unità parte con WSL/systemd, non dipende da una shell aperta e viene riavviata automaticamente dopo un errore. La dashboard mostra `STALE` dopo 90 secondi senza heartbeat e `N/D` se non ne ha mai ricevuto uno.

Con WSL2 verificare inoltre che firewall/NAT consentano segnalazione e intervallo RTP configurato. Dopo ogni modifica usare `asterisk -rx "pjsip show registrations"` e la CLI Asterisk per leggere il codec effettivamente negoziato.
