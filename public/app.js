const money = cents => new Intl.NumberFormat('it-CH',{style:'currency',currency:'CHF'}).format(cents/100);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const clock = iso => new Intl.DateTimeFormat('it-CH',{hour:'2-digit',minute:'2-digit'}).format(new Date(iso));
const clockSec = iso => new Intl.DateTimeFormat('it-CH',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(iso));
const maskPhones=value=>String(value??'').replace(/\+?\d(?:[\s().-]*\d){6,}/g,phone=>{if((phone.match(/\./g)||[]).length>=3)return phone;const digits=phone.replace(/\D/g,'');return digits.length>4?`***${digits.slice(-4)}`:'***'});
document.querySelector('#today').textContent = new Intl.DateTimeFormat('it-CH',{weekday:'long',day:'numeric',month:'long'}).format(new Date());

async function request(url, options) {
  const response = await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options?.headers||{})}});
  if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || 'Operazione non riuscita');
  return response.json();
}
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function since(iso){
  const minutes=Math.floor((Date.now()-Date.parse(iso))/60000);
  if(!Number.isFinite(minutes)||minutes<1)return 'adesso';
  if(minutes<60)return `da ${minutes} min`;
  return `da ${Math.floor(minutes/60)} h`;
}

/* ───────────── Ordini ───────────── */
const statuses=['NEW','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED'];
const labels={NEW:'Nuovo',CONFIRMED:'Confermato',PREPARING:'In preparazione',READY:'Pronto',COMPLETED:'Completato',CANCELLED:'Annullato'};
const rank={NEW:0,CONFIRMED:1,PREPARING:2,READY:3};
// Il flusso in pizzeria è lineare: un solo bottone per il passo successivo, il resto è correzione.
const nextStep={NEW:['PREPARING','Inizia a preparare'],CONFIRMED:['PREPARING','Inizia a preparare'],PREPARING:['READY','Segna pronto'],READY:['COMPLETED','Consegnato']};

function orderCard(order){
  const [nextStatus,nextLabel]=nextStep[order.status]||[];
  const late=['NEW','CONFIRMED','PREPARING'].includes(order.status)&&Date.now()-Date.parse(order.createdAt)>20*60000;
  return `<article class="order s-${order.status.toLowerCase()}${late?' late':''}">
    <div class="order-head">
      <span class="status-chip">${labels[order.status]}</span>
      <h3>${esc(order.customerName)}</h3>
      <span class="fulfillment">${order.fulfillment==='pickup'?'Ritiro':'Consegna'}</span>
      <span class="order-when"><time>${clock(order.createdAt)}</time><small>${since(order.createdAt)}</small></span>
      <strong class="order-total">${money(order.totalCents)}</strong>
    </div>
    <ul class="order-items">${order.items.map(i=>`<li><b>${i.quantity}×</b> ${esc(i.name)}${i.modifiers.length?` <span class="mods">${i.modifiers.map(m=>esc(m.name)).join(', ')}</span>`:''}</li>`).join('')}</ul>
    ${order.deliveryAddress?`<p class="order-address">${esc(order.deliveryAddress)}</p>`:''}
    <div class="order-actions">
      ${nextStatus?`<button class="primary" data-advance="${esc(order.id)}" data-next="${nextStatus}">${nextLabel}</button>`:''}
      <details class="more"><summary>Altro stato</summary>
        <select data-order="${esc(order.id)}" aria-label="Stato ${esc(order.orderNumber)}">${statuses.map(s=>`<option value="${s}" ${s===order.status?'selected':''}>${labels[s]}</option>`).join('')}</select>
      </details>
      <span class="order-number">${esc(order.orderNumber)}</span>
    </div>
  </article>`;
}

async function loadOrders(){
  const orders=await request('/api/orders');
  const active=orders.filter(o=>o.status in rank).sort((a,b)=>rank[a.status]-rank[b.status]||Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const archived=orders.filter(o=>!(o.status in rank)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  document.querySelector('#orderCount').textContent=active.length;
  document.querySelector('#todoCount').textContent=orders.filter(o=>['NEW','CONFIRMED','PREPARING'].includes(o.status)).length;
  document.querySelector('#readyCount').textContent=orders.filter(o=>o.status==='READY').length;
  document.querySelector('#doneCount').textContent=orders.filter(o=>o.status==='COMPLETED').length;
  document.querySelector('#revenue').textContent=money(orders.filter(o=>o.status!=='CANCELLED').reduce((s,o)=>s+o.totalCents,0));
  document.querySelector('#ordersList').innerHTML=active.length?active.map(orderCard).join(''):'<div class="empty">Nessun ordine in lavorazione. Il prossimo apparirà qui.</div>';
  document.querySelector('#archiveList').innerHTML=archived.map(orderCard).join('');
  document.querySelector('#archiveCount').textContent=archived.length;
  document.querySelector('#archive').hidden=!archived.length;
  const setStatus=async(id,status)=>{await request(`/api/orders/${encodeURIComponent(id)}/status`,{method:'PATCH',body:JSON.stringify({status})});toast(`Ordine ${labels[status].toLowerCase()}`);loadOrders()};
  document.querySelectorAll('[data-advance]').forEach(el=>el.addEventListener('click',()=>setStatus(el.dataset.advance,el.dataset.next)));
  document.querySelectorAll('[data-order]').forEach(el=>el.addEventListener('change',e=>setStatus(e.target.dataset.order,e.target.value)));
}

/* ───────────── Menu ───────────── */
async function loadMenu(){
  const menu=await request('/api/menu');
  document.querySelector('#menuList').innerHTML=menu.map(i=>`<div class="menu-row${i.active?'':' off'}" data-item="${esc(i.id)}"><input class="item-name" type="text" value="${esc(i.name)}" aria-label="Nome prodotto"><label>CHF <input class="item-price" type="number" min="0" step="0.5" value="${(i.priceCents/100).toFixed(2)}" aria-label="Prezzo"></label><label class="switch"><input class="item-active" type="checkbox" ${i.active?'checked':''}> In vendita</label><button class="save">Salva</button></div>`).join('');
  document.querySelectorAll('.menu-row .save').forEach(button=>button.addEventListener('click',async e=>{const row=e.target.closest('.menu-row');await request(`/api/menu/${encodeURIComponent(row.dataset.item)}`,{method:'PATCH',body:JSON.stringify({name:row.querySelector('.item-name').value,priceCents:Math.round(Number(row.querySelector('.item-price').value)*100),active:row.querySelector('.item-active').checked})});toast('Prodotto salvato');loadMenu()}));
}

/* ───────────── Telefonia ───────────── */
const stateLabel=(ok,yes,no='Non disponibile')=>ok===true?`<span class="state good">${yes}</span>`:ok===false?`<span class="state bad">${no}</span>`:`<span class="state neutral">N/D</span>`;
async function loadTelephony(){
  const [status,usage]=await Promise.all([request('/api/telephony/status'),request('/api/usage/monthly')]);
  const ok=status.heartbeatState==='current'&&status.asteriskOnline&&status.sipRegistration==='registered';
  const heartbeatLabel=status.heartbeatState==='stale'?'Heartbeat non aggiornato':status.heartbeatState==='unknown'?'Stato da verificare':ok?'Centralino collegato':'Problema telefonia';
  const banner=document.querySelector('#overallStatus');
  banner.innerHTML=`<i></i> ${heartbeatLabel}`;
  banner.className=`live ${ok?'ok':status.heartbeatState==='unknown'?'unknown':'ko'}`;
  document.querySelector('#telephonyChecked').textContent=`Ultimo controllo: ${status.checkedAt?new Intl.DateTimeFormat('it-CH',{dateStyle:'short',timeStyle:'short'}).format(new Date(status.checkedAt)):'N/D'}`;
  const unavailable=status.heartbeatState==='stale'?'<span class="state stale">Non aggiornato</span>':'<span class="state neutral">N/D</span>';
  document.querySelector('#telephonyCards').innerHTML=[
    ['Numero',`${esc(status.number)}<small>${esc(status.provider)} ${esc(status.plan)}</small>`],
    ['Asterisk',status.heartbeatState==='current'?stateLabel(status.asteriskOnline,'Online','Offline'):unavailable],
    ['Registrazione SIP',status.heartbeatState==='current'?stateLabel(status.sipRegistration==='registered','Registrata',status.sipRegistration==='unregistered'?'Non registrata':'N/D'):unavailable],
    ['OpenAI Realtime',stateLabel(status.openaiRealtime==='ready','Configurato','In attesa')],
    ['Voice agent',`${esc(status.realtimeModel)}<small>voce ${esc(status.voice)} · ${esc(status.turnDetection)}</small>`],
    ['Trasferimento umano',stateLabel(status.humanTransfer,'Configurato','Non configurato')],
    ['Backend',stateLabel(status.backendOnline,'Online','Offline')],
    ['PostgreSQL',stateLabel(status.databaseOnline,'Connesso','Non connesso')]
  ].map(([name,value])=>`<article><span>${name}</span><strong>${value}</strong></article>`).join('');
  document.querySelector('#monthlyCalls').textContent=usage.calls;
  document.querySelector('#monthlyDuration').textContent=`${Math.floor(usage.durationSeconds/60)} min ${usage.durationSeconds%60} s`;
  document.querySelector('#openaiCost').textContent=usage.usageSource==='N/D'?'N/D':new Intl.NumberFormat('it-CH',{style:'currency',currency:'USD',minimumFractionDigits:4}).format(usage.openaiCostUsdMicros/1_000_000);
  document.querySelector('#usageSource').textContent=usage.usageSource;
  document.querySelector('#sipcallCost').textContent=money(usage.sipcallMonthlyChfCents);
}

/* ───────────── Conversazioni ───────────── */
const speaker={customer:'Cliente',agent:'Pizzeria'};
const outcomeTone={confermato:'good',trasferita:'stale','in corso':'live',chiusa:'neutral'};
// Sotto il secondo la telefonata scorre; oltre i due secondi il silenzio si sente.
const latencyTone=ms=>ms<1000?'fast':ms<2000?'ok':'slow';
const seconds=ms=>`${(ms/1000).toFixed(ms<10000?1:0)}s`;

const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
function metricChips(call){
  const m=call.metrics,chips=[`${call.durationSeconds}s`,plural(m.customerTurns+m.agentTurns,'battuta','battute')];
  if(m.avgResponseMs!==undefined)chips.push(`<span class="lat ${latencyTone(m.avgResponseMs)}">risposta ${seconds(m.avgResponseMs)}</span>`);
  if(m.bargeIns)chips.push(`<span class="lat ok">${plural(m.bargeIns,'interruzione','interruzioni')}</span>`);
  return chips.map(c=>`<span class="chip">${c}</span>`).join('');
}

function turnRow(turn){
  const technical=turn.role==='tool'||turn.role==='system';
  const latency=turn.latencyMs!==undefined?`<span class="lat ${latencyTone(turn.latencyMs)}" title="Attesa prima di rispondere">${seconds(turn.latencyMs)}</span>`:'';
  return `<div class="turn ${turn.role}${turn.bargeIn?' barge':''}${technical?' technical':''}">
    <span class="turn-at">+${Math.round(turn.offsetMs/1000)}s</span>
    <div class="turn-body">
      ${technical?'':`<span class="turn-who">${speaker[turn.role]}</span>`}
      <span class="turn-text">${esc(maskPhones(turn.text))}</span>
      ${latency}
    </div>
  </div>`;
}

function conversationCard(call,open){
  return `<details class="conversation" ${open?'open':''}>
    <summary>
      <span class="conv-time">${clockSec(call.startedAt)}</span>
      <span class="state ${outcomeTone[call.outcome]||'neutral'}">${esc(call.outcome)}</span>
      <span class="conv-headline">${call.headline?esc(call.headline):'&nbsp;'}</span>
      <span class="conv-metrics">${metricChips(call)}</span>
    </summary>
    <div class="turns">${call.turns.map(turnRow).join('')}</div>
  </details>`;
}

async function loadConversations(){
  const calls=await request('/api/conversations?limit=10');
  document.querySelector('#conversationList').innerHTML=calls.length
    ? calls.map((call,index)=>conversationCard(call,index===0)).join('')
    : '<div class="empty">Nessuna telefonata registrata.<small>Le trascrizioni esistono solo per le chiamate fatte in Modalità test.</small></div>';
}
document.querySelector('#showTechnical').addEventListener('change',e=>document.querySelector('#conversations').classList.toggle('with-technical',e.target.checked));

/* ───────────── Live Logs ───────────── */
let liveLogEvents=[],logFilter='all',logSearch='',logStream,testModeExpiresAt;
function matchesLogFilter(event){
  if(logSearch&&!`${event.source} ${event.message}`.toLowerCase().includes(logSearch))return false;
  if(logFilter==='all')return true;
  if(logFilter==='errors')return event.level==='ERROR';
  return ({telephony:'TELEPHONY',openai:'OPENAI',backend:'BACKEND',tool:'TOOL',database:'DATABASE'})[logFilter]===event.category;
}
function renderLogs(){
  const list=document.querySelector('#liveLogList');
  const visible=[...liveLogEvents].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).filter(matchesLogFilter);
  let lastCall;
  list.innerHTML=visible.length?visible.map(event=>{
    // Un separatore per chiamata: senza, il flusso è un muro indistinto.
    const divider=event.callId&&event.callId!==lastCall?`<div class="log-divider"><span>${esc(maskPhones(event.callId))}</span></div>`:'';
    lastCall=event.callId||lastCall;
    return `${divider}<div class="log-row l-${event.level.toLowerCase()}">
      <time>${clockSec(event.timestamp)}</time>
      <b class="source c-${event.category.toLowerCase()}">${esc(event.source)}</b>
      <span class="log-message">${esc(maskPhones(event.message))}</span>
    </div>`;
  }).join(''):'<div class="empty">Nessun evento per questo filtro.</div>';
  list.scrollTop=list.scrollHeight;
}
function addLiveLog(event){if(liveLogEvents.some(item=>item.id===event.id))return;liveLogEvents.push(event);liveLogEvents=liveLogEvents.slice(-500);renderLogs()}
async function loadLogs(){liveLogEvents=await request('/api/live-logs?limit=300');renderLogs()}
function startLogStream(){
  if(logStream)return;logStream=new EventSource('/api/live-logs/stream');
  logStream.addEventListener('open',()=>{const el=document.querySelector('#streamStatus');el.className='state live';el.textContent='Live'});
  logStream.addEventListener('log',event=>{try{addLiveLog(JSON.parse(event.data))}catch{}});
  logStream.addEventListener('error',()=>{const el=document.querySelector('#streamStatus');el.className='state stale';el.textContent='Riconnessione…'});
}
function renderTestMode(){
  const remaining=testModeExpiresAt?Math.max(0,Date.parse(testModeExpiresAt)-Date.now()):0;
  const button=document.querySelector('#testMode'),countdown=document.querySelector('#testModeCountdown');
  if(!remaining){testModeExpiresAt=undefined;button.textContent='Abilita modalità test';button.classList.remove('danger');countdown.textContent='Trascrizioni non registrate';return}
  button.textContent='Disabilita modalità test';button.classList.add('danger');
  countdown.textContent=`Registra ancora per ${Math.ceil(remaining/60000)} min`;
}
async function loadTestMode(){const state=await request('/api/test-mode');testModeExpiresAt=state.expiresAt||undefined;renderTestMode()}
document.querySelector('#testMode').addEventListener('click',async()=>{
  const enabled=!testModeExpiresAt;
  const state=await request('/api/test-mode',{method:'POST',body:JSON.stringify({enabled})});
  testModeExpiresAt=state.expiresAt||undefined;renderTestMode();
  toast(enabled?'Modalità test attiva per 15 minuti: le telefonate vengono trascritte':'Modalità test disattivata');
});
document.querySelectorAll('[data-log-filter]').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('[data-log-filter]').forEach(item=>item.classList.remove('active'));
  button.classList.add('active');logFilter=button.dataset.logFilter;renderLogs();
}));
document.querySelector('#logSearch').addEventListener('input',e=>{logSearch=e.target.value.trim().toLowerCase();renderLogs()});
setInterval(renderTestMode,1000);

/* ───────────── Navigazione ───────────── */
const loaders={menu:loadMenu,telephony:loadTelephony,conversations:loadConversations};
const failInto={menu:'#menuList',telephony:'#telephonyCards',conversations:'#conversationList',liveLogs:'#liveLogList'};
function openTab(name){
  document.querySelectorAll('[data-tab],.panel').forEach(x=>x.classList.remove('active'));
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.querySelector(`#${name}`).classList.add('active');
  const fail=e=>{document.querySelector(failInto[name]).innerHTML=`<div class="empty">${esc(e.message)}</div>`};
  if(loaders[name])loaders[name]().catch(fail);
  if(name==='liveLogs'){Promise.all([loadLogs(),loadTestMode()]).catch(fail);startLogStream()}
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>openTab(button.dataset.tab)));
document.querySelector('#refresh').addEventListener('click',()=>{
  const current=document.querySelector('.panel.active').id;
  loadOrders();
  if(loaders[current])loaders[current]();
  if(current==='liveLogs')Promise.all([loadLogs(),loadTestMode()]);
  toast('Dati aggiornati');
});
loadOrders().catch(e=>document.querySelector('#ordersList').innerHTML=`<div class="empty">${esc(e.message)}</div>`);
loadTelephony().catch(()=>{});
setInterval(()=>{if(document.querySelector('#orders').classList.contains('active'))loadOrders()},15000);
