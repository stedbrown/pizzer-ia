const money = cents => new Intl.NumberFormat('it-CH',{style:'currency',currency:'CHF'}).format(cents/100);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const statuses = ['NEW','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED'];
const labels = {NEW:'Nuovo',CONFIRMED:'Confermato',PREPARING:'In preparazione',READY:'Pronto',COMPLETED:'Completato',CANCELLED:'Annullato'};
document.querySelector('#today').textContent = new Intl.DateTimeFormat('it-CH',{weekday:'long',day:'numeric',month:'long'}).format(new Date()).toUpperCase();

async function request(url, options) {
  const response = await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options?.headers||{})}});
  if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || 'Operazione non riuscita');
  return response.json();
}
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}

async function loadOrders(){
  const orders=await request('/api/orders');
  document.querySelector('#orderCount').textContent=orders.length;
  document.querySelector('#todoCount').textContent=orders.filter(o=>['NEW','CONFIRMED','PREPARING'].includes(o.status)).length;
  document.querySelector('#readyCount').textContent=orders.filter(o=>o.status==='READY').length;
  document.querySelector('#revenue').textContent=money(orders.filter(o=>o.status!=='CANCELLED').reduce((s,o)=>s+o.totalCents,0));
  document.querySelector('#ordersList').innerHTML=orders.length?orders.map(o=>`<article class="order">
    <div class="order-id"><strong>${esc(o.orderNumber)}</strong><time>${new Intl.DateTimeFormat('it-CH',{hour:'2-digit',minute:'2-digit'}).format(new Date(o.createdAt))}</time></div>
    <div><h3>${esc(o.customerName)}</h3><ul>${o.items.map(i=>`<li><b>${i.quantity}×</b> ${esc(i.name)} ${i.modifiers.length?`<span class="mods">— ${i.modifiers.map(m=>esc(m.name)).join(', ')}</span>`:''}</li>`).join('')}</ul><span class="fulfillment">${o.fulfillment==='pickup'?'Ritiro':'Consegna'}</span></div>
    <div class="order-total"><strong>${money(o.totalCents)}</strong><select data-order="${esc(o.id)}" aria-label="Stato ${esc(o.orderNumber)}">${statuses.map(s=>`<option value="${s}" ${s===o.status?'selected':''}>${labels[s]}</option>`).join('')}</select></div>
  </article>`).join(''):'<div class="empty">Nessun ordine ancora. Il prossimo apparirà qui.</div>';
  document.querySelectorAll('[data-order]').forEach(el=>el.addEventListener('change',async e=>{await request(`/api/orders/${encodeURIComponent(e.target.dataset.order)}/status`,{method:'PATCH',body:JSON.stringify({status:e.target.value})});toast('Stato aggiornato');loadOrders()}));
}

async function loadMenu(){
  const menu=await request('/api/menu');
  document.querySelector('#menuList').innerHTML=menu.map(i=>`<div class="menu-row" data-item="${esc(i.id)}"><input class="item-name" type="text" value="${esc(i.name)}" aria-label="Nome prodotto"><label>CHF <input class="item-price" type="number" min="0" step="0.5" value="${(i.priceCents/100).toFixed(2)}" aria-label="Prezzo"></label><label class="switch"><input class="item-active" type="checkbox" ${i.active?'checked':''}> Attivo</label><button class="save">Salva</button></div>`).join('');
  document.querySelectorAll('.menu-row .save').forEach(button=>button.addEventListener('click',async e=>{const row=e.target.closest('.menu-row');await request(`/api/menu/${encodeURIComponent(row.dataset.item)}`,{method:'PATCH',body:JSON.stringify({name:row.querySelector('.item-name').value,priceCents:Math.round(Number(row.querySelector('.item-price').value)*100),active:row.querySelector('.item-active').checked})});toast('Prodotto salvato')}));
}
const stateLabel=(ok,yes,no='Non disponibile')=>ok===true?`<span class="state good">${yes}</span>`:ok===false?`<span class="state bad">${no}</span>`:`<span class="state neutral">N/D</span>`;
async function loadTelephony(){
  const [status,usage]=await Promise.all([request('/api/telephony/status'),request('/api/usage/monthly')]);
  const heartbeatLabel=status.heartbeatState==='stale'?'Heartbeat STALE':status.heartbeatState==='unknown'?'Stato da verificare':status.asteriskOnline&&status.sipRegistration==='registered'?'Centralino collegato':'Problema telefonia';
  document.querySelector('#overallStatus').innerHTML=`<i></i> ${heartbeatLabel}`;
  document.querySelector('#telephonyChecked').textContent=`Ultimo controllo: ${status.checkedAt?new Intl.DateTimeFormat('it-CH',{dateStyle:'short',timeStyle:'short'}).format(new Date(status.checkedAt)):'N/D'}`;
  const heartbeatUnavailable=status.heartbeatState==='stale'?'<span class="state stale">STALE</span>':'<span class="state neutral">N/D</span>';
  document.querySelector('#telephonyCards').innerHTML=[
    ['Numero',`${esc(status.number)} · ${esc(status.provider)} ${esc(status.plan)}`],
    ['Asterisk',status.heartbeatState==='current'?stateLabel(status.asteriskOnline,'Online','Offline'):heartbeatUnavailable],
    ['Registrazione SIP',status.heartbeatState==='current'?stateLabel(status.sipRegistration==='registered','Registrata',status.sipRegistration==='unregistered'?'Non registrata':'N/D'):heartbeatUnavailable],
    ['OpenAI Realtime',stateLabel(status.openaiRealtime==='ready','Configurato','In attesa')],
    ['Backend',stateLabel(status.backendOnline,'Online','Offline')],
    ['PostgreSQL',stateLabel(status.databaseOnline,'Connesso','Non connesso')]
  ].map(([name,value])=>`<article><span>${name}</span><strong>${value}</strong></article>`).join('');
  document.querySelector('#monthlyCalls').textContent=usage.calls;
  document.querySelector('#monthlyDuration').textContent=`${Math.floor(usage.durationSeconds/60)} min ${usage.durationSeconds%60} s`;
  document.querySelector('#openaiCost').textContent=usage.usageSource==='N/D'?'N/D':new Intl.NumberFormat('it-CH',{style:'currency',currency:'USD',minimumFractionDigits:4}).format(usage.openaiCostUsdMicros/1_000_000);
  document.querySelector('#usageSource').textContent=usage.usageSource;
  document.querySelector('#sipcallCost').textContent=money(usage.sipcallMonthlyChfCents);
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-tab],.panel').forEach(x=>x.classList.remove('active'));button.classList.add('active');document.querySelector(`#${button.dataset.tab}`).classList.add('active');if(button.dataset.tab==='menu')loadMenu();if(button.dataset.tab==='telephony')loadTelephony().catch(e=>document.querySelector('#telephonyCards').innerHTML=`<div class="empty">${esc(e.message)}</div>`)}));
document.querySelector('#refresh').addEventListener('click',()=>{loadOrders();if(document.querySelector('#telephony').classList.contains('active'))loadTelephony();toast('Dati aggiornati')});
loadOrders().catch(e=>document.querySelector('#ordersList').innerHTML=`<div class="empty">${esc(e.message)}</div>`);
loadTelephony().catch(()=>{});
setInterval(()=>{if(document.querySelector('#orders').classList.contains('active'))loadOrders()},15000);
