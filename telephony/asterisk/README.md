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

L'unità parte con WSL/systemd, non dipende da una shell aperta e viene riavviata automaticamente dopo un errore. Le richieste outbound hanno timeout espliciti, così un collegamento bloccato termina e lascia intervenire `Restart=always`. La dashboard mostra `STALE` dopo 90 secondi senza heartbeat e `N/D` se non ne ha mai ricevuto uno.

WSL può arrestare l'intera distro quando non esistono processi Windows collegati, anche se systemd ha servizi attivi. Sul PC di produzione è quindi presente l'attività pianificata Windows `Pizzer-IA WSL Keepalive`, avviata al login con `wsl.exe -d Ubuntu --exec /bin/sleep infinity`. L'attività non apre finestre, non espone porte e serve solo a mantenere viva la distro; systemd continua a gestire e riavviare heartbeat e Asterisk.

La modalità test viene richiesta dalla dashboard e scade lato server dopo massimo 15 minuti. Solo durante quella finestra lo script abilita `pjsip set logger on`, legge dal journal esclusivamente gli eventi SIP importanti e lo disabilita alla scadenza o all'arresto del servizio. I riepiloghi RTP derivano da `pjsip show channelstats`; `rtp set debug` non viene mai abilitato. Nessuna porta inbound viene aggiunta.

Con WSL2 verificare inoltre che firewall/NAT consentano segnalazione e intervallo RTP configurato. Dopo ogni modifica usare `asterisk -rx "pjsip show registrations"` e la CLI Asterisk per leggere il codec effettivamente negoziato.
