(function(){
"use strict";

/* ============ CONFIG / CLIENTE SUPABASE ============
   window.DARVIK_CONFIG vem de js/config.js (URL e chave publica "anon" do
   Supabase, ambas seguras para ficar visiveis no codigo publicado). O script
   do CDN do Supabase (carregado antes deste arquivo, em index.html) cria
   window.supabase. */
var supabaseClient = window.supabase.createClient(window.DARVIK_CONFIG.SUPABASE_URL, window.DARVIK_CONFIG.SUPABASE_ANON_KEY);
var PAGE_TITLE = 'DARVIK';
var LOGO_URL = 'assets/logo.jpg';

/* ============ STATE ============
   Continua sendo um unico objeto em memoria, na mesma forma de sempre — so
   que agora, em vez de vir embutido no HTML, e carregado do Supabase apos o
   login (loadAllData()) e sincronizado de volta a cada alteracao
   (saveState() -> flushSave() -> syncAllToSupabase()). */
var STATE = { meta:{orgName:'DARVIK', seq:{}}, users:[], categories:[], suppliers:[], customers:[], products:[], locations:[], stock:[], stockMovements:[], purchaseOrders:[], storageTasks:[], salesOrders:[], payments:[], shipments:[], auditLog:[], alerts:[] };

/* ============ SESSAO ============
   SESSION.userId guarda o "legacy_id" do perfil (ex.: "u1") — o mesmo
   formato curto que o sistema sempre usou internamente — para que todo o
   resto do codigo (currentUser, findUser, addAudit, NAV_GROUPS, etc.)
   continue funcionando sem nenhuma mudanca. CURRENT_AUTH guarda a sessao
   real do Supabase Auth (usada para autenticacao e para assinar as
   chamadas a Edge Function). */
var SESSION = null;
var CURRENT_AUTH = null;

/* ============ UTILITIES ============ */
function uid(kind){ var k = STATE.meta.seq[kind] || 1; STATE.meta.seq[kind] = k+1; return kind+'-'+k; }
function pad4(n){ n=String(n); while(n.length<4) n='0'+n; return n; }
function esc(str){
  if(str===null||str===undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(ts){
  if(!ts) return '—';
  var d = new Date(ts);
  return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
function fmtDateOnly(ts){ if(!ts) return '—'; return new Date(ts).toLocaleDateString('pt-BR'); }
function money(v){
  v = Number(v)||0;
  return v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
}
function byId(arr, id){ for(var i=0;i<arr.length;i++){ if(arr[i].id===id) return arr[i]; } return null; }
function findUser(id){ return byId(STATE.users, id); }
function findProduct(id){ return byId(STATE.products, id); }
function findLocation(id){ return byId(STATE.locations, id); }
function findCategory(id){ return byId(STATE.categories, id); }
function findSupplier(id){ return byId(STATE.suppliers, id); }
function findCustomer(id){ return byId(STATE.customers, id); }
function findPO(id){ return byId(STATE.purchaseOrders, id); }
function findSO(id){ return byId(STATE.salesOrders, id); }
function variationName(product, variationId){
  if(!variationId || !product || !product.variations) return null;
  var v = byId(product.variations, variationId);
  return v ? v.name : null;
}
function productLabel(productId, variationId){
  var p = findProduct(productId);
  if(!p) return '(produto removido)';
  var lbl = p.name;
  var vn = variationName(p, variationId);
  if(vn) lbl += ' — '+vn;
  return lbl;
}
function locationLabel(locId){
  var l = findLocation(locId);
  if(!l) return '—';
  return l.code;
}
function currentUser(){ return SESSION ? findUser(SESSION.userId) : null; }

function addAudit(action, entityType, entityId, details){
  var u = currentUser();
  STATE.auditLog.unshift({
    id: uid('audit'), timestamp: Date.now(),
    userId: u? u.id: null, userName: u? u.name : 'Sistema',
    action: action, entityType: entityType, entityId: entityId, details: details||''
  });
}
function addMovement(type, productId, variationId, quantity, locationId, refType, refId, note){
  var u = currentUser();
  STATE.stockMovements.unshift({
    id: uid('mov'), type:type, productId:productId, variationId:variationId||null,
    quantity:quantity, locationId:locationId, userId:u?u.id:null, userName:u?u.name:'Sistema',
    timestamp:Date.now(), refType:refType||null, refId:refId||null, note:note||''
  });
}

/* stock helpers */
function stockRecord(productId, variationId, locationId, create){
  for(var i=0;i<STATE.stock.length;i++){
    var s = STATE.stock[i];
    if(s.productId===productId && (s.variationId||null)===(variationId||null) && s.locationId===locationId) return s;
  }
  if(create){
    var rec = { id: uid('stock'), productId:productId, variationId:variationId||null, locationId:locationId, quantity:0 };
    STATE.stock.push(rec);
    return rec;
  }
  return null;
}
function adjustStock(productId, variationId, locationId, delta){
  var rec = stockRecord(productId, variationId, locationId, true);
  rec.quantity += delta;
  if(rec.quantity <= 0 && rec.quantity >= -0.0001){
    STATE.stock = STATE.stock.filter(function(s){ return s.id!==rec.id; });
  }
}
function totalStockForProduct(productId, variationId){
  var total = 0;
  STATE.stock.forEach(function(s){
    if(s.productId===productId && (variationId===undefined || (s.variationId||null)===(variationId||null))) total += s.quantity;
  });
  return total;
}
function stockAtLocation(locationId){
  var total = 0;
  STATE.stock.forEach(function(s){ if(s.locationId===locationId) total += s.quantity; });
  return total;
}
function locationsForProduct(productId, variationId){
  return STATE.stock.filter(function(s){
    return s.productId===productId && (variationId===undefined || (s.variationId||null)===(variationId||null)) && s.quantity>0;
  }).sort(function(a,b){ return b.quantity-a.quantity; });
}
function suggestLocationForNewItem(){
  var best = null, bestFree = -1;
  STATE.locations.forEach(function(l){
    var occ = stockAtLocation(l.id);
    var free = (l.capacity||0) - occ;
    if(free > bestFree){ bestFree = free; best = l; }
  });
  if(best && bestFree > 0) return best;
  return null;
}

/* role helpers */
var ROLE_LABELS = { ADMIN:'Administrador', OPERADOR_CADASTROS:'Operador de Cadastros', COMPRADOR:'Comprador', OPERADOR_ESTOQUE:'Operador de Estoque', VENDEDOR:'Vendedor', CONFERENTE:'Conferente' };
function roleLabel(r){ return ROLE_LABELS[r] || r; }
function hasRole(){
  var u = currentUser();
  if(!u) return false;
  if(u.role==='ADMIN') return true;
  for(var i=0;i<arguments.length;i++){ if(u.role===arguments[i]) return true; }
  return false;
}

/* ============ PERSISTENCIA (Supabase) ============
   Estrategia: a cada alteracao, reenviamos o array inteiro de cada tabela
   afetada — por simplicidade e para nunca esquecer de sincronizar algo —
   via upsert, e apagamos do banco qualquer linha que nao exista mais
   localmente ("reconciliacao"). Isso e funcionalmente equivalente ao que o
   sistema ja fazia antes (republicar o documento inteiro a cada
   salvamento), so que agora so os dados via a API do Supabase, nao o HTML
   inteiro — e de fato bem mais leve que o comportamento anterior. */
function setSaveIndicator(mode){
  var el = document.getElementById('save-indicator');
  if(!el) return;
  el.classList.remove('saving','error');
  if(mode==='saving'){ el.classList.add('saving'); el.querySelector('span.txt').textContent='Salvando…'; }
  else if(mode==='error'){ el.classList.add('error'); el.querySelector('span.txt').textContent='Não sincronizado'; }
  else { el.querySelector('span.txt').textContent='Sincronizado'; }
}

var SAVE_TIMER = null;
var SAVE_PENDING = false;
function saveState(){
  SAVE_PENDING = true;
  if(SAVE_TIMER) clearTimeout(SAVE_TIMER);
  SAVE_TIMER = setTimeout(flushSave, 450);
  render(); /* re-render local otimista imediato */
}

function flushSave(){
  SAVE_TIMER = null;
  if(!SAVE_PENDING) return;
  SAVE_PENDING = false;
  setSaveIndicator('saving');
  syncAllToSupabase().then(function(){
    setSaveIndicator('ok');
  }).catch(function(err){
    console.error('Falha ao sincronizar com o Supabase:', err);
    setSaveIndicator('error');
    toast('Não foi possível salvar agora. Verifique sua internet.', 'bad');
  });
}

function syncTable(table, rows){
  rows = rows || [];
  var db = supabaseClient;
  var ids = rows.map(function(r){ return r.id; });
  var p = rows.length ? db.from(table).upsert(rows).then(function(res){ if(res.error) throw res.error; }) : Promise.resolve();
  return p.then(function(){
    var delQuery = db.from(table).delete();
    delQuery = ids.length ? delQuery.not('id','in','('+ids.map(function(i){ return '"'+String(i).replace(/"/g,'')+'"'; }).join(',')+')') : delQuery.gte('id','');
    return delQuery.then(function(res){ if(res.error) throw res.error; });
  });
}

function mapProductOut(p){ return { id:p.id, sku:p.sku, name:p.name, category_id:p.categoryId||null, brand:p.brand||null, price:(p.price===undefined?null:p.price), variations:p.variations||[], created_at: p.createdAt? new Date(p.createdAt).toISOString(): undefined }; }
function mapLocationOut(l){ return { id:l.id, corridor:l.corridor||null, shelf:l.shelf||null, level:l.level||null, capacity:l.capacity||null, code:l.code||null, qr_payload:l.qrPayload||null }; }
function mapStockOut(s){ return { id:s.id, product_id:s.productId, variation_id:s.variationId||null, location_id:s.locationId, quantity:s.quantity }; }
function mapMovementOut(m){ return { id:m.id, type:m.type, product_id:m.productId||null, variation_id:m.variationId||null, quantity:m.quantity, location_id:m.locationId||null, user_id:m.userId||null, user_name:m.userName||null, "timestamp": m.timestamp? new Date(m.timestamp).toISOString(): undefined, ref_type:m.refType||null, ref_id:m.refId||null, note:m.note||null }; }
function mapPoOut(po){ return { id:po.id, code:po.code, supplier_id:po.supplierId||null, items:po.items||[], status:po.status, expected_date: po.expectedDate? new Date(po.expectedDate).toISOString(): null, created_at: po.createdAt? new Date(po.createdAt).toISOString(): undefined, created_by:po.createdBy||null }; }
function mapStorageTaskOut(t){ return { id:t.id, po_id:t.poId||null, po_item_id:t.poItemId||null, product_id:t.productId||null, variation_id:t.variationId||null, qty_pending:t.qtyPending, suggested_location_id:t.suggestedLocationId||null, status:t.status }; }
function mapSoOut(so){ return { id:so.id, code:so.code, channel:so.channel, customer_id:so.customerId||null, items:so.items||[], status:so.status, priority:so.priority||null, created_at: so.createdAt? new Date(so.createdAt).toISOString(): undefined, created_by:so.createdBy||null }; }
function mapPaymentOut(p){ return { id:p.id, sales_order_id:p.salesOrderId||null, amount:(p.amount===undefined?null:p.amount), method:p.method||null, note:p.note||null, created_at: p.createdAt? new Date(p.createdAt).toISOString(): undefined, created_by:p.createdBy||null }; }
function mapShipmentOut(s){ return { id:s.id, sales_order_id:s.salesOrderId||null, tracking_code:s.trackingCode||null, status:s.status||null, events:s.events||[], created_at: s.createdAt? new Date(s.createdAt).toISOString(): undefined }; }
function mapAuditOut(a){ return { id:a.id, "timestamp": a.timestamp? new Date(a.timestamp).toISOString(): undefined, user_id:a.userId||null, user_name:a.userName||null, action:a.action||null, entity_type:a.entityType||null, entity_id:a.entityId||null, details:a.details||null }; }

function syncAllToSupabase(){
  var jobs = [
    syncTable('categories', STATE.categories),
    syncTable('suppliers', STATE.suppliers),
    syncTable('customers', STATE.customers),
    syncTable('products', STATE.products.map(mapProductOut)),
    syncTable('locations', STATE.locations.map(mapLocationOut)),
    syncTable('stock', STATE.stock.map(mapStockOut)),
    syncTable('stock_movements', STATE.stockMovements.map(mapMovementOut)),
    syncTable('purchase_orders', STATE.purchaseOrders.map(mapPoOut)),
    syncTable('storage_tasks', STATE.storageTasks.map(mapStorageTaskOut)),
    syncTable('sales_orders', STATE.salesOrders.map(mapSoOut)),
    syncTable('payments', STATE.payments.map(mapPaymentOut)),
    syncTable('shipments', STATE.shipments.map(mapShipmentOut)),
    syncTable('audit_log', STATE.auditLog.map(mapAuditOut)),
    supabaseClient.from('org_meta').update({ org_name: STATE.meta.orgName, seq: STATE.meta.seq }).eq('id','main').then(function(res){ if(res.error) throw res.error; })
  ];
  return Promise.all(jobs);
}

/* ============ CARREGAR DADOS DO SUPABASE ============ */
function mapProductIn(p){ return { id:p.id, sku:p.sku, name:p.name, categoryId:p.category_id, brand:p.brand, price: p.price!=null? Number(p.price): p.price, variations:p.variations||[], createdAt: p.created_at? new Date(p.created_at).getTime(): null }; }
function mapLocationIn(l){ return { id:l.id, corridor:l.corridor, shelf:l.shelf, level:l.level, capacity:l.capacity, code:l.code, qrPayload:l.qr_payload }; }
function mapStockIn(s){ return { id:s.id, productId:s.product_id, variationId:s.variation_id, locationId:s.location_id, quantity: Number(s.quantity) }; }
function mapMovementIn(m){ return { id:m.id, type:m.type, productId:m.product_id, variationId:m.variation_id, quantity:Number(m.quantity), locationId:m.location_id, userId:m.user_id, userName:m.user_name, timestamp: m.timestamp? new Date(m.timestamp).getTime(): null, refType:m.ref_type, refId:m.ref_id, note:m.note }; }
function mapPoIn(po){ return { id:po.id, code:po.code, supplierId:po.supplier_id, items:po.items||[], status:po.status, expectedDate: po.expected_date? new Date(po.expected_date).getTime(): null, createdAt: po.created_at? new Date(po.created_at).getTime(): null, createdBy:po.created_by }; }
function mapStorageTaskIn(t){ return { id:t.id, poId:t.po_id, poItemId:t.po_item_id, productId:t.product_id, variationId:t.variation_id, qtyPending: t.qty_pending!=null? Number(t.qty_pending): t.qty_pending, suggestedLocationId:t.suggested_location_id, status:t.status }; }
function mapSoIn(so){ return { id:so.id, code:so.code, channel:so.channel, customerId:so.customer_id, items:so.items||[], status:so.status, priority:so.priority, createdAt: so.created_at? new Date(so.created_at).getTime(): null, createdBy:so.created_by }; }
function mapPaymentIn(p){ return { id:p.id, salesOrderId:p.sales_order_id, amount: p.amount!=null? Number(p.amount): p.amount, method:p.method, note:p.note, createdAt: p.created_at? new Date(p.created_at).getTime(): null, createdBy:p.created_by }; }
function mapShipmentIn(s){ return { id:s.id, salesOrderId:s.sales_order_id, trackingCode:s.tracking_code, status:s.status, events:s.events||[], createdAt: s.created_at? new Date(s.created_at).getTime(): null }; }
function mapAuditIn(a){ return { id:a.id, timestamp: a.timestamp? new Date(a.timestamp).getTime(): null, userId:a.user_id, userName:a.user_name, action:a.action, entityType:a.entity_type, entityId:a.entity_id, details:a.details }; }
function mapProfileToUser(p){ return { id:p.legacy_id, name:p.name, username:p.login, role:p.role, active:p.active, customPermissions:p.custom_permissions||null }; }

async function loadAllData(){
  var db = supabaseClient;
  var results = await Promise.all([
    db.from('profiles').select('*'),
    db.from('categories').select('*'),
    db.from('suppliers').select('*'),
    db.from('customers').select('*'),
    db.from('products').select('*'),
    db.from('locations').select('*'),
    db.from('stock').select('*'),
    db.from('stock_movements').select('*').order('timestamp', {ascending:false}).limit(2000),
    db.from('purchase_orders').select('*'),
    db.from('storage_tasks').select('*'),
    db.from('sales_orders').select('*'),
    db.from('payments').select('*'),
    db.from('shipments').select('*'),
    db.from('audit_log').select('*').order('timestamp', {ascending:false}).limit(1000),
    db.from('org_meta').select('*').eq('id','main').maybeSingle()
  ]);
  results.forEach(function(r){ if(r.error) throw r.error; });
  var profiles=results[0], categories=results[1], suppliers=results[2], customers=results[3], products=results[4],
      locations=results[5], stock=results[6], stockMovements=results[7], purchaseOrders=results[8],
      storageTasks=results[9], salesOrders=results[10], payments=results[11], shipments=results[12],
      auditLog=results[13], orgMeta=results[14];
  STATE.users = (profiles.data||[]).map(mapProfileToUser);
  STATE.categories = categories.data||[];
  STATE.suppliers = suppliers.data||[];
  STATE.customers = customers.data||[];
  STATE.products = (products.data||[]).map(mapProductIn);
  STATE.locations = (locations.data||[]).map(mapLocationIn);
  STATE.stock = (stock.data||[]).map(mapStockIn);
  STATE.stockMovements = (stockMovements.data||[]).map(mapMovementIn);
  STATE.purchaseOrders = (purchaseOrders.data||[]).map(mapPoIn);
  STATE.storageTasks = (storageTasks.data||[]).map(mapStorageTaskIn);
  STATE.salesOrders = (salesOrders.data||[]).map(mapSoIn);
  STATE.payments = (payments.data||[]).map(mapPaymentIn);
  STATE.shipments = (shipments.data||[]).map(mapShipmentIn);
  STATE.auditLog = (auditLog.data||[]).map(mapAuditIn);
  STATE.meta.orgName = (orgMeta.data && orgMeta.data.org_name) || 'DARVIK';
  STATE.meta.seq = (orgMeta.data && orgMeta.data.seq) || {};
}

/* Chama a Edge Function "manage-user" (unico caminho para criar/editar login
   e senha de outra pessoa — precisa da chave de servico, que so existe do
   lado do servidor). Sempre manda o token da sessao atual, para a funcao
   confirmar que quem esta chamando tem mesmo acesso a tela "Usuarios". */
async function callManageUser(payload){
  var sessionRes = await supabaseClient.auth.getSession();
  var session = sessionRes.data && sessionRes.data.session;
  if(!session) throw new Error('Sessão expirada — faça login novamente.');
  var res = await fetch(window.DARVIK_CONFIG.SUPABASE_URL + '/functions/v1/manage-user', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+session.access_token },
    body: JSON.stringify(payload)
  });
  var body = await res.json().catch(function(){ return {}; });
  if(!res.ok) throw new Error(body.error || 'Erro ao salvar usuário.');
  return body;
}

/* ============ TOASTS ============ */
function toast(msg, kind){
  var root = document.getElementById('toast-root');
  if(!root) return;
  var el = document.createElement('div');
  el.className = 'toast'+(kind? ' '+kind : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3600);
}

/* ============ MODAL ============ */
function openModal(innerHtml, opts){
  closeModal();
  opts = opts || {};
  var backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'active-modal';
  backdrop.addEventListener('mousedown', function(e){ if(e.target===backdrop) closeModal(); });
  var modal = document.createElement('div');
  modal.className = 'modal'+(opts.wide? ' modal-wide':'');
  modal.innerHTML = innerHtml;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
function closeModal(){
  var m = document.getElementById('active-modal');
  if(m) m.remove();
}
window.closeModal = closeModal;

/* ============ ROUTER ============ */
var ROUTES = {}; /* path -> render function */
function setRoute(path){ location.hash = path; }
window.setRoute = setRoute;
function currentPath(){ return (location.hash||'#/dashboard').slice(1); }

window.addEventListener('hashchange', render);

/* ============ SHELL / NAV ============ */
/* cada item pode ter "roles": [...] — quem tem ADMIN sempre vê tudo; sem
   "roles" definido, o item fica visível para qualquer usuário logado
   (ex.: Dashboard). As telas de armazenagem, separação e conferência foram
   removidas deste sistema — esse trabalho passa a ser feito no sistema
   coletor; aqui só ficam os status/contadores (Dashboard) e o histórico. */
var NAV_GROUPS = [
  { label:'Visão geral', items:[
    { path:'dashboard', label:'Dashboard', icon:'📊' }
  ]},
  { label:'Cadastros', items:[
    { path:'localizacoes', label:'Localizações', roles:['OPERADOR_ESTOQUE','OPERADOR_CADASTROS'] },
    { path:'fornecedores', label:'Fornecedores', roles:['OPERADOR_ESTOQUE','OPERADOR_CADASTROS'] },
    { path:'categorias', label:'Categorias', roles:['OPERADOR_ESTOQUE','OPERADOR_CADASTROS'] },
    { path:'produtos', label:'Produtos', roles:['OPERADOR_ESTOQUE','OPERADOR_CADASTROS'] }
  ]},
  { label:'Compras', items:[
    { path:'compras', label:'Pedidos de compra', roles:['OPERADOR_ESTOQUE','COMPRADOR'], count:function(){ return STATE.purchaseOrders.filter(function(p){return p.status==='AGUARDANDO_RECEBIMENTO' || p.status==='RECEBIMENTO_COM_DIVERGENCIA';}).length; } }
  ]},
  { label:'Estoque', items:[
    { path:'recebimento', label:'Recebimento', roles:['OPERADOR_ESTOQUE'], count:function(){ return STATE.purchaseOrders.filter(function(p){return p.status==='AGUARDANDO_RECEBIMENTO';}).length; } },
    { path:'estoque', label:'Estoque atual', roles:['OPERADOR_ESTOQUE'] },
    { path:'consulta-estoque', label:'Consulta de estoque', roles:['OPERADOR_ESTOQUE'] },
    { path:'movimentacoes', label:'Movimentações', roles:['OPERADOR_ESTOQUE'] },
    { path:'expedicao', label:'Expedição (online)', roles:['VENDEDOR','OPERADOR_ESTOQUE'], count:function(){ return STATE.salesOrders.filter(function(o){return o.status==='AGUARDANDO_EXPEDICAO';}).length; } }
  ]},
  { label:'Vendas', items:[
    { path:'vendas', label:'Pedidos de venda', roles:['VENDEDOR'] },
    { path:'pagamento', label:'Pagamento (loja)', roles:['VENDEDOR'], count:function(){ return STATE.salesOrders.filter(function(o){return o.status==='AGUARDANDO_PAGAMENTO';}).length; } },
    { path:'clientes', label:'Clientes', roles:['VENDEDOR'] }
  ]},
  { label:'Administração', items:[
    { path:'usuarios', label:'Usuários', roles:['ADMIN'] },
    { path:'historico', label:'Histórico / auditoria', roles:['ADMIN'] }
  ]}
];
function canAccessRoute(path){
  var user = currentUser();
  if(!user) return false;
  if(user.role==='ADMIN') return true;
  var item = null;
  NAV_GROUPS.forEach(function(g){ g.items.forEach(function(it){ if(it.path===path) item = it; }); });
  if(!item || !item.roles) return true;
  /* Acesso personalizado por tela (Versão 17): se o usuário tem uma lista
     explícita de permissões (definida na tela de Usuários), ela é a única
     fonte de verdade para os itens com "roles" — a função dele só serve de
     ponto de partida (marca as telas padrão ao criar/editar o usuário).
     Sem essa lista definida (todo usuário cadastrado antes desta versão),
     mantém o comportamento antigo, baseado só no papel. */
  if(user.customPermissions){ return user.customPermissions.indexOf(path) >= 0; }
  return item.roles.indexOf(user.role) >= 0;
}

function renderShell(){
  var root = document.getElementById('root');
  var html = '';
  html += '<div id="app">';
  html += '<aside id="sidebar">';
  html += '<div class="brand"><img class="brand-logo" src="'+LOGO_URL+'" alt="'+esc(STATE.meta.orgName)+'"><div class="sub">Logistics &amp; Technology</div></div>';
  html += '<nav>';
  NAV_GROUPS.forEach(function(g){
    var visibleItems = g.items.filter(function(it){ return canAccessRoute(it.path); });
    if(!visibleItems.length) return;
    html += '<div class="nav-group"><div class="nav-group-label">'+esc(g.label)+'</div>';
    visibleItems.forEach(function(it){
      var active = currentPath()===it.path;
      var count = it.count ? it.count() : null;
      html += '<a class="nav-link'+(active?' active':'')+'" href="#/'+it.path+'"><span>'+esc(it.label)+'</span>'+(count? '<span class="nav-count">'+count+'</span>':'')+'</a>';
    });
    html += '</div>';
  });
  html += '</nav>';
  var u = currentUser();
  html += '<div class="session-box">';
  if(u){
    html += '<div class="who">'+esc(u.name)+'</div><div class="role">'+esc(roleLabel(u.role))+'</div>';
    html += '<button id="btn-logout">Trocar usuário</button>';
  }
  html += '</div>';
  html += '</aside>';
  html += '<div id="sidebar-backdrop"></div>';
  html += '<div id="main">';
  html += '<div id="topbar"><button id="menu-toggle" type="button" aria-label="Abrir menu">☰</button><h2 id="page-title"></h2><div id="save-indicator"><span class="dot"></span><span class="txt">Sincronizado</span></div></div>';
  html += '<div id="view"></div>';
  html += '</div>';
  html += '</div>';
  html += '<div id="toast-root"></div>';
  root.innerHTML = html;
  var lo = document.getElementById('btn-logout');
  if(lo) lo.addEventListener('click', function(){ supabaseClient.auth.signOut().then(function(){ SESSION=null; CURRENT_AUTH=null; render(); }); });
  function setSidebarOpen(open){
    var sb = document.getElementById('sidebar'), bd = document.getElementById('sidebar-backdrop');
    if(sb) sb.classList.toggle('open', open);
    if(bd) bd.classList.toggle('open', open);
  }
  var mt = document.getElementById('menu-toggle');
  if(mt) mt.addEventListener('click', function(){ setSidebarOpen(true); });
  var bd = document.getElementById('sidebar-backdrop');
  if(bd) bd.addEventListener('click', function(){ setSidebarOpen(false); });
  document.querySelectorAll('.nav-link').forEach(function(a){ a.addEventListener('click', function(){ setSidebarOpen(false); }); });
}

/* ============ LOGIN ============
   Usa o Supabase Auth de verdade: o "usuário" digitado é primeiro traduzido
   para um e-mail interno (login_lookup, view pública que só expõe essa
   tradução, nunca senha) e então autenticado via signInWithPassword. A
   mensagem de erro continua genérica de propósito (não revela se o login
   existe ou não), igual ao sistema anterior. */
function renderLogin(){
  var root = document.getElementById('root');
  var html = '<div id="login-screen"><div class="login-card">';
  html += '<img class="login-logo" src="'+LOGO_URL+'" alt="DARVIK">';
  html += '<p>Entre com seu usuário e senha.</p>';
  html += '<div class="field"><label>Usuário</label><input type="text" id="f-login-user" autocomplete="username" autocapitalize="off" autocorrect="off"></div>';
  html += '<div class="field"><label>Senha</label><input type="password" id="f-login-pass" autocomplete="current-password"></div>';
  html += '<div id="login-error" class="login-error" style="display:none"></div>';
  html += '<button class="btn btn-primary" id="btn-login" style="width:100%">Entrar</button>';
  html += '<p class="small muted mt14">Não tem um login? Peça ao administrador do sistema para cadastrar seu usuário.</p>';
  html += '</div></div>';
  root.innerHTML = html;

  function showLoginError(msg){
    var el = document.getElementById('login-error');
    el.textContent = msg; el.style.display = 'block';
  }
  async function doLogin(){
    var uname = document.getElementById('f-login-user').value.trim().toLowerCase();
    var pass = document.getElementById('f-login-pass').value;
    document.getElementById('login-error').style.display = 'none';
    if(!uname || !pass){ showLoginError('Informe usuário e senha.'); return; }
    var btn = document.getElementById('btn-login');
    btn.disabled = true;
    try{
      var lookup = await supabaseClient.from('login_lookup').select('email').eq('login', uname).maybeSingle();
      if(lookup.error || !lookup.data){ showLoginError('Usuário ou senha inválidos.'); btn.disabled=false; return; }
      var signIn = await supabaseClient.auth.signInWithPassword({ email: lookup.data.email, password: pass });
      if(signIn.error){ showLoginError('Usuário ou senha inválidos.'); btn.disabled=false; return; }
      CURRENT_AUTH = signIn.data.session;
      await loadAllData();
      var me = STATE.users.find(function(u){ return u.username === uname; });
      if(!me || !me.active){ showLoginError('Usuário desativado. Fale com o administrador.'); await supabaseClient.auth.signOut(); btn.disabled=false; return; }
      SESSION = { userId: me.id };
      render();
    }catch(e){
      console.error(e);
      showLoginError('Não foi possível entrar agora. Verifique sua internet e tente de novo.');
      btn.disabled=false;
    }
  }
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('f-login-user').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('f-login-pass').focus(); } });
  document.getElementById('f-login-pass').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); doLogin(); } });
}

/* ============ MAIN RENDER DISPATCH ============ */
var PAGE_TITLES = {
  dashboard:'Dashboard', produtos:'Produtos', categorias:'Categorias', localizacoes:'Localizações',
  fornecedores:'Fornecedores', clientes:'Clientes',
  compras:'Pedidos de compra', recebimento:'Recebimento', estoque:'Estoque atual', movimentacoes:'Movimentações',
  'consulta-estoque':'Consulta de estoque',
  vendas:'Pedidos de venda',
  pagamento:'Pagamento (loja física)', expedicao:'Expedição (vendas online)', usuarios:'Usuários', historico:'Histórico / auditoria'
};

function render(){
  if(!SESSION || !currentUser()){ renderLogin(); return; }
  var path = currentPath();
  var seg = path.split('/').filter(Boolean);
  var base = seg[0] || 'dashboard';
  if(!PAGE_TITLES[base]) base = 'dashboard';

  if(!canAccessRoute(base)){
    toast('Você não tem acesso a esta área.','bad');
    if(location.hash !== '#/dashboard'){ location.hash = '#/dashboard'; return; }
    base = 'dashboard';
  }

  var needsShell = !document.getElementById('sidebar');
  if(needsShell) renderShell();
  else {
    document.querySelectorAll('.nav-link').forEach(function(a){ a.classList.remove('active'); });
    var activeLink = document.querySelector('a[href="#/'+base+'"]');
    if(activeLink) activeLink.classList.add('active');
    NAV_GROUPS.forEach(function(g){ g.items.forEach(function(it){
      if(!canAccessRoute(it.path) || !it.count) return;
      var a = document.querySelector('a[href="#/'+it.path+'"]');
      if(!a) return;
      var val = it.count();
      var badge = a.querySelector('.nav-count');
      if(val){
        if(!badge){ badge = document.createElement('span'); badge.className = 'nav-count'; a.appendChild(badge); }
        badge.textContent = val;
      } else if(badge){
        badge.remove();
      }
    });});
    var who = document.querySelector('.session-box .who');
    if(who) who.textContent = currentUser().name;
  }
  document.getElementById('page-title').textContent = PAGE_TITLES[base];

  var view = document.getElementById('view');
  var fn = ROUTES[base];
  view.innerHTML = fn ? fn(seg.slice(1)) : '<div class="empty-state">Página não encontrada.</div>';
  var after = ROUTES[base+'__after'];
  if(after) after(seg.slice(1));
}

/* ============ GENERIC UI HELPERS ============ */
function selectOptions(items, valueKey, labelFn, selected){
  return items.map(function(it){
    var v = it[valueKey];
    return '<option value="'+esc(v)+'"'+(String(selected)===String(v)?' selected':'')+'>'+esc(labelFn(it))+'</option>';
  }).join('');
}
function statusBadge(status){
  var map = {
    AGUARDANDO_RECEBIMENTO:['warn','Aguardando recebimento'], RECEBIMENTO_COM_DIVERGENCIA:['bad','Divergência no recebimento'],
    RECEBIDO:['info','Recebido'], ARMAZENADO:['accent','Armazenado'], CONCLUIDO:['good','Concluído'], CANCELADO:['bad','Cancelado'],
    AGUARDANDO_SEPARACAO:['warn','Aguardando separação'], EM_SEPARACAO:['accent','Em separação'], SEPARADO:['info','Separado'],
    EM_CONFERENCIA:['accent','Em conferência'], CONFERIDO:['info','Conferido'],
    AGUARDANDO_PAGAMENTO:['warn','Aguardando pagamento'], PAGO:['good','Pago'],
    AGUARDANDO_EXPEDICAO:['warn','Aguardando expedição'], ENVIADO:['accent','Enviado'], ENTREGUE:['good','Entregue'],
    PENDENTE:['warn','Pendente']
  };
  var m = map[status] || ['info', status];
  return '<span class="badge badge-'+m[0]+'">'+esc(m[1])+'</span>';
}
function emptyState(msg, actionHtml){
  return '<div class="empty-state">'+esc(msg)+(actionHtml? '<div>'+actionHtml+'</div>':'')+'</div>';
}

/* ============ QR CODE ============ */
var QR_LIB_STATE = 'idle'; /* idle | loading | ready | failed */
var QR_LIB_QUEUE = [];
function ensureQrLib(cb){
  if(QR_LIB_STATE==='ready'){ cb(true); return; }
  if(QR_LIB_STATE==='failed'){ cb(false); return; }
  QR_LIB_QUEUE.push(cb);
  if(QR_LIB_STATE==='loading') return;
  QR_LIB_STATE='loading';
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  s.onload = function(){ QR_LIB_STATE='ready'; QR_LIB_QUEUE.forEach(function(f){f(true);}); QR_LIB_QUEUE=[]; };
  s.onerror = function(){ QR_LIB_STATE='failed'; QR_LIB_QUEUE.forEach(function(f){f(false);}); QR_LIB_QUEUE=[]; };
  document.head.appendChild(s);
}
function mountQr(elId, text){
  var el = document.getElementById(elId);
  if(!el) return;
  ensureQrLib(function(ok){
    el = document.getElementById(elId);
    if(!el) return;
    if(ok && window.QRCode){
      el.innerHTML='';
      try{ new QRCode(el, { text:text, width:128, height:128, correctLevel: QRCode.CorrectLevel.M }); }
      catch(e){ el.innerHTML = '<div class="small muted">QR indisponível</div>'; }
    } else {
      el.innerHTML = '<div class="small muted">QR indisponível offline — use o código abaixo</div>';
    }
  });
}
function qrBoxHtml(elId, code, displayText){
  return '<div class="qr-box"><div id="'+elId+'"></div><div class="qr-label">'+esc(displayText!==undefined&&displayText!==null?displayText:code)+'</div></div>';
}

/* ============ IMPRESSÃO DE ETIQUETAS EM PDF (visualizar/baixar/imprimir) ============
   A usuária pediu explicitamente um PDF de verdade: ao clicar em "gerar
   etiquetas", ela quer ver um PDF pronto, com a opção de baixar ou só
   visualizar para imprimir — um único caminho que funciona tanto para
   impressora comum (A4) quanto térmica.
   A solução tem duas partes que trabalham juntas:
   1) O PDF é gerado inteiramente no navegador com jsPDF (biblioteca carregada
      via CDN) e embutido diretamente no modal aberto, dentro de um <iframe>
      apontando para um Blob local (URL.createObjectURL) — o próprio
      visualizador de PDF nativo do navegador assume dali em diante, cobrindo
      sempre a opção de VISUALIZAR/IMPRIMIR (o visualizador embutido tem seus
      próprios controles de zoom/impressão). Isso não depende de
      window.print() nem de window.open(), então funciona mesmo dentro do
      sandbox do iframe do Artifact publicado, que não tem allow-modals/
      allow-popups (ver `showPrintPreview` mais abaixo para o histórico dessa
      investigação).
   2) Para BAIXAR o arquivo, um link comum <a download> não funciona dentro
      desse mesmo sandbox (falta allow-downloads — o visualizador de Artifact
      nunca concede essa permissão a links/downloads disparados por script,
      nem mesmo para Blob URLs). Por isso o botão "Baixar PDF" tenta primeiro
      a capacidade nativa `downloads` da plataforma
      (claude.use('downloads') -> downloads.save({filename, data})), que é o
      único caminho da plataforma para entregar um arquivo de verdade ao
      navegador do usuário a partir de um Artifact publicado. Se essa
      capacidade não estiver disponível nesta visualização (ex.: fora do
      Artifact publicado, ou versão antiga do app do usuário), o botão cai de
      volta no link <a download> tradicional — que pelo menos não quebra nada
      e pode funcionar em contextos sem esse sandbox.
   Só se o QR Code ou o jsPDF não carregarem (ex.: falha de rede) é que o
   sistema cai de volta no mecanismo antigo de pré-visualização em HTML com
   instrução manual de Ctrl+P/Cmd+P (`printQrLabels`/`printAllQrLabels` +
   `showPrintPreview`), para nunca deixar a usuária sem nenhuma forma de
   imprimir. */
/* Capacidade `downloads` da plataforma — resolvida uma única vez (o
   resultado fica em cache) e passada adiante para showPdfPreview() no
   momento em que o botão "Baixar PDF" é montado, para que o clique decida
   sincronamente qual caminho usar (downloads.save() vs. <a download> comum)
   em vez de descobrir isso de forma assíncrona dentro do próprio handler de
   clique (o que impediria cancelar a ação padrão do link a tempo). */
var DOWNLOADS_NS; /* undefined=não resolvido ainda, null=indisponível, objeto=pronto */
function ensureDownloadsCapability(cb){
  if(DOWNLOADS_NS !== undefined){ cb(DOWNLOADS_NS); return; }
  if(!window.claude || typeof window.claude.use !== 'function'){ DOWNLOADS_NS = null; cb(null); return; }
  window.claude.use('downloads').then(function(ns){ DOWNLOADS_NS = ns || null; cb(DOWNLOADS_NS); })
    .catch(function(){ DOWNLOADS_NS = null; cb(null); });
}
var JSPDF_LIB_STATE = 'idle'; /* idle | loading | ready | failed */
var JSPDF_LIB_QUEUE = [];
function ensureJsPdf(cb){
  if(JSPDF_LIB_STATE==='ready'){ cb(true); return; }
  if(JSPDF_LIB_STATE==='failed'){ cb(false); return; }
  JSPDF_LIB_QUEUE.push(cb);
  if(JSPDF_LIB_STATE==='loading') return;
  JSPDF_LIB_STATE='loading';
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  s.onload = function(){ JSPDF_LIB_STATE='ready'; JSPDF_LIB_QUEUE.forEach(function(f){f(true);}); JSPDF_LIB_QUEUE=[]; };
  s.onerror = function(){ JSPDF_LIB_STATE='failed'; JSPDF_LIB_QUEUE.forEach(function(f){f(false);}); JSPDF_LIB_QUEUE=[]; };
  document.head.appendChild(s);
}
/* Renderiza o QR (mesmo texto/código para todas as etiquetas de um lote) uma
   única vez num canvas oculto e devolve a imagem como data URL PNG, pronta
   para ser inserida no PDF com doc.addImage(). */
function getQrDataUrl(text, sizePx, cb){
  ensureQrLib(function(ok){
    if(!ok || !window.QRCode){ cb(null); return; }
    var tmp = document.createElement('div');
    tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
    document.body.appendChild(tmp);
    try{
      new QRCode(tmp, { text:text, width:sizePx, height:sizePx, correctLevel: QRCode.CorrectLevel.M });
      setTimeout(function(){
        var url = null;
        var canvas = tmp.querySelector('canvas');
        try{
          if(canvas) url = canvas.toDataURL('image/png');
          else { var img = tmp.querySelector('img'); if(img && img.src) url = img.src; }
        }catch(e){ url = null; }
        if(tmp.parentNode) tmp.parentNode.removeChild(tmp);
        cb(url);
      }, 60);
    }catch(e){
      if(tmp.parentNode) tmp.parentNode.removeChild(tmp);
      cb(null);
    }
  });
}
function sanitizeFileNamePart(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-+|-+$)/g,'') || 'etiqueta';
}
/* Folha A4 em grade 3x7 (21 etiquetas por página), formato comum de folha de
   etiquetas adesivas — cada célula recebe o mesmo QR Code, nome e SKU. */
function buildA4LabelsPdf(qrDataUrl, qty, name, sku){
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ unit:'mm', format:'a4' });
  var margin = 10, cols = 3, rows = 7;
  var cellW = (210 - margin*2) / cols, cellH = (297 - margin*2) / rows;
  var qrSize = Math.min(cellW, cellH) * 0.55;
  var perPage = cols*rows;
  for(var i=0;i<qty;i++){
    var pos = i % perPage;
    if(i>0 && pos===0) doc.addPage();
    var col = pos % cols, row = Math.floor(pos/cols);
    var cellX = margin + col*cellW, cellY = margin + row*cellH;
    doc.setDrawColor(210); doc.setLineWidth(0.2);
    doc.rect(cellX+1, cellY+1, cellW-2, cellH-2);
    var qrX = cellX + (cellW-qrSize)/2, qrY = cellY + 2;
    doc.addImage(qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);
    var textY = qrY + qrSize + 4;
    doc.setFontSize(8);
    doc.text(String(name).substring(0,40), cellX+cellW/2, textY, {align:'center', maxWidth: cellW-4});
    if(sku){ doc.setFontSize(7); doc.text(String(sku), cellX+cellW/2, textY+3.6, {align:'center', maxWidth: cellW-4}); }
  }
  return doc;
}
/* Etiqueta térmica: uma página por etiqueta, no tamanho exato do rolo, para
   que a impressora térmica corte/avance corretamente entre cada uma. */
function buildThermalLabelsPdf(qrDataUrl, qty, thermalWidthMm, name, sku){
  var jsPDF = window.jspdf.jsPDF;
  var w = Number(thermalWidthMm)||58;
  var labelH = Math.round(w*0.85) + 16;
  var doc = new jsPDF({ unit:'mm', format:[w, labelH] });
  var qrSize = w*0.7;
  for(var i=0;i<qty;i++){
    if(i>0) doc.addPage([w, labelH]);
    var qrX = (w-qrSize)/2;
    doc.addImage(qrDataUrl, 'PNG', qrX, 2, qrSize, qrSize);
    doc.setFontSize(Math.max(6, Math.min(9, w/8)));
    doc.text(String(name).substring(0,40), w/2, qrSize+7, {align:'center', maxWidth: w-4});
    if(sku) doc.text(String(sku), w/2, qrSize+11.5, {align:'center', maxWidth: w-4});
  }
  return doc;
}
/* Objeto URL do PDF mostrado por último — revogado antes de criar um novo,
   para não vazar memória a cada etiqueta gerada. */
var CURRENT_PDF_URL = null;
/* Embute o PDF já gerado (objeto jsPDF) dentro do modal atualmente aberto,
   num <iframe> apontando para um Blob local — cobre sempre a opção de
   visualizar/imprimir, via os próprios controles do visualizador de PDF do
   navegador. Para a opção de baixar, o botão "Baixar PDF" usa a capacidade
   `downloads` da plataforma quando `downloadsNs` foi resolvido (ver
   ensureDownloadsCapability acima); se não, cai para um <a download>
   comum. `downloadsNs` é passado pronto pelo chamador (generateAndShow*)
   porque essa resolução é assíncrona e precisa terminar ANTES do botão ser
   montado, para o clique poder decidir de forma síncrona qual caminho usar. */
function showPdfPreview(doc, filename, qty, downloadsNs){
  var modal = document.querySelector('.modal');
  var old = document.getElementById('print-preview-inline');
  if(old) old.remove();
  if(CURRENT_PDF_URL){ try{ URL.revokeObjectURL(CURRENT_PDF_URL); }catch(e){} CURRENT_PDF_URL = null; }
  var blob = doc.output('blob');
  var url = URL.createObjectURL(blob);
  CURRENT_PDF_URL = url;
  if(!modal) return;
  var wrap = document.createElement('div');
  wrap.id = 'print-preview-inline';
  wrap.style.marginTop = '14px';
  var banner = document.createElement('div');
  banner.className = 'readonly-banner';
  banner.style.background = 'var(--accent-bg)'; banner.style.color = 'var(--accent)'; banner.style.borderColor = 'var(--accent)';
  banner.innerHTML = '<strong>PDF com '+qty+' etiqueta(s) pronto.</strong> Use o botão "Baixar PDF" abaixo para baixar o arquivo, ou os controles do próprio visualizador para imprimir — funciona tanto para impressora comum (A4) quanto térmica.';
  wrap.appendChild(banner);
  var actions = document.createElement('div');
  actions.style.cssText = 'margin:8px 0';
  var dl = document.createElement('a');
  dl.href = url; dl.download = filename; dl.className = 'btn btn-sm';
  dl.textContent = '⬇ Baixar PDF';
  if(downloadsNs){
    dl.addEventListener('click', function(e){
      e.preventDefault();
      downloadsNs.save({ filename: filename, data: blob }).then(function(){
        toast('PDF baixado — '+qty+' etiqueta(s) prontas para imprimir.','good');
      }).catch(function(err){
        var errCode = err && err.code;
        if(errCode==='declined') return; /* a usuária cancelou a caixa de confirmação — nada a fazer */
        toast('Não deu pra baixar automaticamente — use os controles do visualizador de PDF abaixo.','bad');
      });
    });
  }
  actions.appendChild(dl);
  wrap.appendChild(actions);
  var frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'Pré-visualização do PDF de etiquetas';
  frame.style.cssText = 'width:100%;height:420px;border:1px solid var(--border);border-radius:10px;background:#fff';
  wrap.appendChild(frame);
  var foot = modal.querySelector('.modal-foot');
  if(foot) modal.insertBefore(wrap, foot); else modal.appendChild(wrap);
  try{ wrap.scrollIntoView({behavior:'smooth', block:'nearest'}); }catch(e){}
}
/* Ponto de entrada principal para gerar/mostrar etiquetas de um único código
   (recebimento item a item, ou localização): monta o PDF e o embute no modal
   via showPdfPreview(); só cai para o mecanismo antigo (printQrLabels) se o
   QR Code ou o jsPDF não carregarem. Resolve a capacidade `downloads` em
   paralelo com QR/jsPDF (não depende dela para gerar o PDF em si — só o
   botão de baixar decide, depois, se usa essa capacidade ou o <a download>). */
function generateAndShowLabelsPdf(code, qty, layout, thermalWidthMm, name, sku){
  qty = Math.max(1, Math.min(500, Math.floor(Number(qty))||0));
  name = name || ''; sku = sku || '';
  ensureDownloadsCapability(function(downloadsNs){
    getQrDataUrl(code, 300, function(qrDataUrl){
      if(!qrDataUrl){ printQrLabels(code, qty, layout, thermalWidthMm, name, sku); return; }
      ensureJsPdf(function(pdfOk){
        if(!pdfOk || !window.jspdf || !window.jspdf.jsPDF){ printQrLabels(code, qty, layout, thermalWidthMm, name, sku); return; }
        var doc;
        try{
          doc = (layout==='a4') ? buildA4LabelsPdf(qrDataUrl, qty, name, sku) : buildThermalLabelsPdf(qrDataUrl, qty, thermalWidthMm, name, sku);
        }catch(e){ printQrLabels(code, qty, layout, thermalWidthMm, name, sku); return; }
        var fname = 'etiquetas-'+sanitizeFileNamePart(sku||name)+'-'+qty+'un.pdf';
        toast('PDF gerado — '+qty+' etiqueta(s).','good');
        showPdfPreview(doc, fname, qty, downloadsNs);
      });
    });
  });
}

/* ============ IMPRESSÃO EM LOTE (todos os itens de uma vez) ============
   Atalho pedido pela usuária: no recebimento, depois de conferir todos os
   itens do pedido, ela queria uma opção, no final, de imprimir de uma vez
   as etiquetas de QR Code de TODOS os itens — em vez de precisar entrar de
   novo, item por item, na etapa "Imprimir QR Codes" de cada um (que já
   existe e continua funcionando igual, caso prefira imprimir aos poucos).
   `entries`: [{code, qty, name, sku}] — um por item do pedido. Mesma lógica
   do caminho individual: gera um único PDF (via jsPDF) com as etiquetas de
   todos os itens e o embute no modal (showPdfPreview) e, só se o QR Code ou
   o jsPDF não carregarem, cai para a pré-visualização em tela com instrução
   de impressão manual (Ctrl+P/Cmd+P). */
function buildMultiLabelsPdf(layout, thermalWidthMm, entries){
  var jsPDF = window.jspdf.jsPDF;
  var doc;
  if(layout==='a4'){
    doc = new jsPDF({ unit:'mm', format:'a4' });
    var margin=10, cols=3, rows=7;
    var cellW=(210-margin*2)/cols, cellH=(297-margin*2)/rows;
    var qrSize = Math.min(cellW,cellH)*0.55;
    var perPage = cols*rows, count=0;
    entries.forEach(function(entry){
      for(var i=0;i<entry.qty;i++){
        var pos = count % perPage;
        if(count>0 && pos===0) doc.addPage();
        var col=pos%cols, row=Math.floor(pos/cols);
        var cellX=margin+col*cellW, cellY=margin+row*cellH;
        doc.setDrawColor(210); doc.setLineWidth(0.2);
        doc.rect(cellX+1, cellY+1, cellW-2, cellH-2);
        var qrX=cellX+(cellW-qrSize)/2, qrY=cellY+2;
        doc.addImage(entry.qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);
        var textY=qrY+qrSize+4;
        doc.setFontSize(8);
        doc.text(String(entry.name).substring(0,40), cellX+cellW/2, textY, {align:'center', maxWidth:cellW-4});
        if(entry.sku){ doc.setFontSize(7); doc.text(String(entry.sku), cellX+cellW/2, textY+3.6, {align:'center', maxWidth:cellW-4}); }
        count++;
      }
    });
  } else {
    var w = Number(thermalWidthMm)||58;
    var labelH = Math.round(w*0.85)+16;
    doc = new jsPDF({ unit:'mm', format:[w,labelH] });
    var qrSize = w*0.7, first=true;
    entries.forEach(function(entry){
      for(var i=0;i<entry.qty;i++){
        if(!first) doc.addPage([w,labelH]);
        first=false;
        var qrX=(w-qrSize)/2;
        doc.addImage(entry.qrDataUrl, 'PNG', qrX, 2, qrSize, qrSize);
        doc.setFontSize(Math.max(6, Math.min(9, w/8)));
        doc.text(String(entry.name).substring(0,40), w/2, qrSize+7, {align:'center', maxWidth:w-4});
        if(entry.sku) doc.text(String(entry.sku), w/2, qrSize+11.5, {align:'center', maxWidth:w-4});
      }
    });
  }
  return doc;
}
function getQrDataUrlsForEntries(items, sizePx, cb){
  var results = [], i = 0;
  function next(){
    if(i>=items.length){ cb(results); return; }
    var it = items[i];
    getQrDataUrl(it.code, sizePx, function(url){
      results.push({ qrDataUrl:url, qty: Math.max(1,Math.min(500,Math.floor(Number(it.qty))||0)), name: it.name||'', sku: it.sku||'' });
      i++; next();
    });
  }
  next();
}
/* Fallback (pré-visualização em tela): igual ao printQrLabels de um item só,
   mas monta as etiquetas de todos os itens numa única área de impressão, com
   o QR de cada etiqueta codificando o código do respectivo item. */
function printAllQrLabels(items, layout, thermalWidthMm){
  items = items.filter(function(it){ return it.qty>0; });
  if(items.length===0){ toast('Nenhum item recebido para imprimir.','bad'); return; }
  var area = document.getElementById('print-area');
  if(!area){ area = document.createElement('div'); area.id='print-area'; document.body.appendChild(area); }
  var pageStyle = document.getElementById('print-page-style');
  if(!pageStyle){ pageStyle = document.createElement('style'); pageStyle.id='print-page-style'; document.head.appendChild(pageStyle); }
  var thermalPx = (Number(thermalWidthMm)||58) * 2;
  var labelsHtml = '', codesByIndex = [], globalIdx = 0, totalQty = 0;
  items.forEach(function(it){
    var qty = Math.max(1, Math.min(500, Math.floor(Number(it.qty))||0));
    var name = it.name||'', sku = it.sku||'';
    for(var i=0;i<qty;i++){
      labelsHtml += '<div class="label-'+(layout==='a4'?'a4':'thermal')+'"><div class="label-qr" id="print-qr-'+globalIdx+'"></div><div class="label-name">'+esc(name)+'</div>'+(sku?'<div class="label-code">'+esc(sku)+'</div>':'')+'</div>';
      codesByIndex.push(it.code);
      globalIdx++; totalQty++;
    }
  });
  area.className = layout==='a4' ? 'print-sheet-a4' : 'print-sheet-thermal';
  area.innerHTML = labelsHtml;
  pageStyle.textContent = layout==='a4' ? '@page { size: A4; margin: 10mm; }' : '@page { size: '+(Number(thermalWidthMm)||58)+'mm auto; margin: 2mm; }';
  ensureQrLib(function(ok){
    codesByIndex.forEach(function(code, i){
      var el = document.getElementById('print-qr-'+i);
      if(!el) return;
      if(ok && window.QRCode){
        try{ new QRCode(el, { text: code, width: layout==='a4'?110:thermalPx, height: layout==='a4'?110:thermalPx, correctLevel: QRCode.CorrectLevel.M }); }
        catch(e){ el.textContent = code; }
      } else { el.textContent = code; }
    });
    setTimeout(function(){ showPrintPreview(totalQty); }, 150);
  });
}
function generateAndShowBatchLabelsPdf(items, layout, thermalWidthMm){
  items = items.filter(function(it){ return it.qty>0; });
  if(items.length===0){ toast('Nenhum item recebido para imprimir.','bad'); return; }
  ensureDownloadsCapability(function(downloadsNs){
    getQrDataUrlsForEntries(items, 300, function(entries){
      if(entries.some(function(e){ return !e.qrDataUrl; })){ printAllQrLabels(items, layout, thermalWidthMm); return; }
      ensureJsPdf(function(pdfOk){
        if(!pdfOk || !window.jspdf || !window.jspdf.jsPDF){ printAllQrLabels(items, layout, thermalWidthMm); return; }
        var doc;
        try{ doc = buildMultiLabelsPdf(layout, thermalWidthMm, entries); }
        catch(e){ printAllQrLabels(items, layout, thermalWidthMm); return; }
        var totalQty = entries.reduce(function(s,e){ return s+e.qty; }, 0);
        var fname = 'etiquetas-recebimento-'+totalQty+'un.pdf';
        toast('PDF gerado — '+totalQty+' etiqueta(s).','good');
        showPdfPreview(doc, fname, totalQty, downloadsNs);
      });
    });
  });
}

/* ============ DASHBOARD ============ */
function isToday(ts){
  if(!ts) return false;
  var d = new Date(ts), now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
}

ROUTES.dashboard = function(){
  var criticalProducts = [];
  STATE.products.forEach(function(p){
    var tot = totalStockForProduct(p.id);
    if(tot===0){ criticalProducts.push({product:p, total:tot}); }
  });
  var lowStockCount = criticalProducts.length;
  var pendingRecebimento = STATE.purchaseOrders.filter(function(p){return p.status==='AGUARDANDO_RECEBIMENTO' || p.status==='RECEBIMENTO_COM_DIVERGENCIA';}).length;
  var pendingArmazenagem = STATE.storageTasks.filter(function(t){return t.status==='PENDENTE';}).length;
  var pendingSeparacao = STATE.salesOrders.filter(function(o){return o.status==='AGUARDANDO_SEPARACAO' || o.status==='EM_SEPARACAO';}).length;
  var pendingConferencia = STATE.salesOrders.filter(function(o){return o.status==='EM_CONFERENCIA';}).length;
  var pendingPagamento = STATE.salesOrders.filter(function(o){return o.status==='AGUARDANDO_PAGAMENTO';}).length;
  var pendingExpedicao = STATE.salesOrders.filter(function(o){return o.status==='AGUARDANDO_EXPEDICAO';}).length;

  var salesToday = STATE.salesOrders.filter(function(o){ return isToday(o.createdAt); });
  var revenueToday = STATE.payments.filter(function(p){ return isToday(p.timestamp); }).reduce(function(sum,p){ return sum+(p.amount||0); }, 0);

  var totalUnitsInStock = 0;
  STATE.stock.forEach(function(s){ totalUnitsInStock += s.quantity; });
  var distinctProductsWithStock = {};
  STATE.stock.forEach(function(s){ distinctProductsWithStock[s.productId]=true; });

  var html = '';
  html += '<div class="kpi-row">';
  html += '<div class="kpi"><div class="label">Produtos cadastrados</div><div class="value">'+STATE.products.length+'</div></div>';
  html += '<div class="kpi"><div class="label">Localizações</div><div class="value">'+STATE.locations.length+'</div></div>';
  html += '<div class="kpi warn"><div class="label">Produtos sem estoque</div><div class="value">'+lowStockCount+'</div></div>';
  html += '<div class="kpi accent"><div class="label">Pedidos de venda ativos</div><div class="value">'+STATE.salesOrders.filter(function(o){return o.status!=='CONCLUIDO' && o.status!=='CANCELADO';}).length+'</div></div>';
  html += '<div class="kpi accent"><div class="label">Vendas hoje</div><div class="value">'+salesToday.length+'</div></div>';
  html += '<div class="kpi good"><div class="label">Faturamento hoje</div><div class="value">'+money(revenueToday)+'</div></div>';
  html += '</div>';

  html += '<div class="detail-grid">';

  html += '<div class="card"><h3>Estoque atual</h3>';
  html += '<div class="stat-line"><span class="k">Unidades em estoque</span><span>'+totalUnitsInStock+'</span></div>';
  html += '<div class="stat-line"><span class="k">Produtos com estoque</span><span>'+Object.keys(distinctProductsWithStock).length+' / '+STATE.products.length+'</span></div>';
  if(criticalProducts.length===0){
    html += '<p class="small muted mt8">Nenhum produto zerado no momento.</p>';
  } else {
    html += '<p class="small muted mt8">Produtos sem estoque:</p>';
    html += '<ul class="timeline">';
    criticalProducts.slice(0,6).forEach(function(c){
      html += '<li>'+esc(c.product.name)+' <span class="badge badge-bad">0 un.</span></li>';
    });
    html += '</ul>';
    if(criticalProducts.length>6) html += '<p class="small muted">+'+(criticalProducts.length-6)+' outro(s).</p>';
  }
  html += '</div>';

  html += '<div class="card"><h3>Vendas e faturamento</h3>';
  html += '<div class="stat-line"><span class="k">Vendas do dia</span><span>'+salesToday.length+'</span></div>';
  html += '<div class="stat-line"><span class="k">Faturamento diário</span><span>'+money(revenueToday)+'</span></div>';
  html += '<p class="small muted mt8">Faturamento diário considera os pagamentos recebidos hoje na loja física. Vendas online não têm pagamento registrado neste sistema.</p>';
  html += '</div>';

  html += '<div class="card"><h3>Filas pendentes</h3>';
  html += '<div class="stat-line"><span class="k">Aguardando recebimento</span><span>'+pendingRecebimento+'</span></div>';
  html += '<div class="stat-line"><span class="k">Aguardando armazenagem</span><span>'+pendingArmazenagem+'</span></div>';
  html += '<div class="stat-line"><span class="k">Fila de separação</span><span>'+pendingSeparacao+'</span></div>';
  html += '<div class="stat-line"><span class="k">Aguardando conferência</span><span>'+pendingConferencia+'</span></div>';
  html += '<div class="stat-line"><span class="k">Aguardando pagamento</span><span>'+pendingPagamento+'</span></div>';
  html += '<div class="stat-line"><span class="k">Aguardando expedição</span><span>'+pendingExpedicao+'</span></div>';
  html += '</div>';

  html += '<div class="card"><h3>Movimentações recentes</h3>';
  if(STATE.stockMovements.length===0){ html += emptyState('Nenhuma movimentação registrada ainda.'); }
  else {
    html += '<ul class="timeline">';
    STATE.stockMovements.slice(0,8).forEach(function(m){
      html += '<li><span class="t">'+fmtDate(m.timestamp)+' · '+esc(m.userName)+'</span>'+statusMovBadge(m.type)+' '+esc(productLabel(m.productId,m.variationId))+' — '+m.quantity+' un. · '+esc(locationLabel(m.locationId))+'</li>';
    });
    html += '</ul>';
  }
  html += '</div>';

  html += '<div class="card"><h3>Atividade recente</h3>';
  if(STATE.auditLog.length===0){ html += emptyState('Nenhuma atividade registrada ainda.'); }
  else {
    html += '<ul class="timeline">';
    STATE.auditLog.slice(0,10).forEach(function(a){
      html += '<li><span class="t">'+fmtDate(a.timestamp)+' · '+esc(a.userName)+'</span>'+esc(a.action)+(a.details? ' — '+esc(a.details):'')+'</li>';
    });
    html += '</ul>';
  }
  html += '</div></div>';
  return html;
};

/* ============ CATEGORIAS ============ */
ROUTES.categorias = function(){
  var html = '<div class="toolbar"><div class="toolbar-left"></div><button class="btn btn-primary" id="btn-add-cat">+ Nova categoria</button></div>';
  if(STATE.categories.length===0){
    html += emptyState('Nenhuma categoria cadastrada.', '<button class="btn btn-primary" id="btn-add-cat-2">+ Nova categoria</button>');
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Nome</th><th>Produtos</th><th></th></tr></thead><tbody>';
    STATE.categories.forEach(function(c){
      var count = STATE.products.filter(function(p){return p.categoryId===c.id;}).length;
      html += '<tr><td>'+esc(c.name)+'</td><td>'+count+'</td><td class="right">';
      html += '<button class="btn btn-sm" data-edit-cat="'+c.id+'">Editar</button> ';
      html += '<button class="btn btn-sm btn-danger" data-del-cat="'+c.id+'"'+(count>0?' disabled title="Categoria em uso"':'')+'>Excluir</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
};
ROUTES.categorias__after = function(){
  var add = document.getElementById('btn-add-cat') || document.getElementById('btn-add-cat-2');
  if(add) add.addEventListener('click', function(){ openCategoryForm(null); });
  document.querySelectorAll('[data-edit-cat]').forEach(function(b){ b.addEventListener('click', function(){ openCategoryForm(byId(STATE.categories, b.getAttribute('data-edit-cat'))); }); });
  document.querySelectorAll('[data-del-cat]').forEach(function(b){ b.addEventListener('click', function(){
    if(b.disabled) return;
    STATE.categories = STATE.categories.filter(function(c){ return c.id!==b.getAttribute('data-del-cat'); });
    addAudit('Excluiu categoria', 'categoria', b.getAttribute('data-del-cat'), '');
    toast('Categoria removida.'); saveState();
  }); });
};
function openCategoryForm(cat){
  var html = '<div class="modal-head"><h3>'+(cat?'Editar categoria':'Nova categoria')+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field"><label>Nome</label><input type="text" id="f-cat-name" value="'+(cat?esc(cat.name):'')+'"></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-cat">Salvar</button></div>';
  openModal(html);
  document.getElementById('save-cat').addEventListener('click', function(){
    var name = document.getElementById('f-cat-name').value.trim();
    if(!name){ toast('Informe um nome.', 'bad'); return; }
    if(cat){ cat.name=name; addAudit('Editou categoria','categoria',cat.id,name); }
    else { var id=uid('cat'); STATE.categories.push({id:id, name:name}); addAudit('Criou categoria','categoria',id,name); }
    closeModal(); toast('Categoria salva.','good'); saveState();
  });
}

/* ============ LOCALIZAÇÕES ============ */
ROUTES.localizacoes = function(){
  var html = '<div class="toolbar"><div class="toolbar-left"></div><button class="btn btn-primary" id="btn-add-loc">+ Nova localização</button></div>';
  if(STATE.locations.length===0){
    html += emptyState('Nenhuma localização cadastrada. Cadastre corredores, prateleiras e níveis para poder armazenar produtos.', '<button class="btn btn-primary" id="btn-add-loc-2">+ Nova localização</button>');
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Corredor</th><th>Prateleira</th><th>Nível</th><th>Ocupação</th><th></th></tr></thead><tbody>';
    STATE.locations.forEach(function(l){
      var occ = stockAtLocation(l.id);
      html += '<tr><td class="code-cell">'+esc(l.code)+'</td><td>'+esc(l.corridor)+'</td><td>'+esc(l.shelf)+'</td><td>'+esc(l.level)+'</td>';
      html += '<td class="qty">'+occ+' / '+l.capacity+'</td>';
      html += '<td class="right"><button class="btn btn-sm" data-view-loc="'+l.id+'">Ver</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
};
ROUTES.localizacoes__after = function(){
  var add = document.getElementById('btn-add-loc') || document.getElementById('btn-add-loc-2');
  if(add) add.addEventListener('click', function(){ openLocationForm(); });
  document.querySelectorAll('[data-view-loc]').forEach(function(b){ b.addEventListener('click', function(){ openLocationDetail(b.getAttribute('data-view-loc')); }); });
};
function openLocationForm(){
  var html = '<div class="modal-head"><h3>Nova localização</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field-row3">';
  html += '<div class="field"><label>Corredor</label><input type="text" id="f-loc-corridor" placeholder="A"></div>';
  html += '<div class="field"><label>Prateleira</label><input type="text" id="f-loc-shelf" placeholder="03"></div>';
  html += '<div class="field"><label>Nível</label><input type="text" id="f-loc-level" placeholder="2"></div>';
  html += '</div>';
  html += '<div class="field"><label>Capacidade (unidades)</label><input type="number" id="f-loc-capacity" value="100" min="1"></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-loc">Salvar</button></div>';
  openModal(html);
  document.getElementById('save-loc').addEventListener('click', function(){
    var corridor=document.getElementById('f-loc-corridor').value.trim();
    var shelf=document.getElementById('f-loc-shelf').value.trim();
    var level=document.getElementById('f-loc-level').value.trim();
    var capacity=Number(document.getElementById('f-loc-capacity').value)||0;
    if(!corridor||!shelf||!level){ toast('Preencha corredor, prateleira e nível.','bad'); return; }
    var code = corridor+'-'+shelf+'-'+level;
    if(STATE.locations.some(function(l){return l.code===code;})){ toast('Já existe uma localização com este código.','bad'); return; }
    var id = uid('loc');
    STATE.locations.push({ id:id, corridor:corridor, shelf:shelf, level:level, capacity:capacity, code:code, qrPayload:'LOC:'+id });
    addAudit('Criou localização','localizacao',id,code);
    toast('Localização criada.','good'); saveState();
    openLocationDetail(id, true);
  });
}
function openLocationDetail(locId, justCreated){
  var l = findLocation(locId);
  if(!l) return;
  var items = STATE.stock.filter(function(s){return s.locationId===locId;});
  var html = '<div class="modal-head"><h3>Localização '+esc(l.code)+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  if(justCreated) html += '<div class="readonly-banner" style="background:var(--good-bg);color:var(--good);border-color:var(--good)">Localização criada. O QR Code abaixo identifica esta posição — cole uma etiqueta impressa dele na prateleira para bipar depois.</div>';
  html += '<div class="detail-grid">';
  html += qrBoxHtml('loc-qr-'+l.id, l.qrPayload, l.code);
  html += '<div><div class="stat-line"><span class="k">Capacidade</span><span>'+l.capacity+' un.</span></div>';
  html += '<div class="stat-line"><span class="k">Ocupação atual</span><span>'+stockAtLocation(l.id)+' un.</span></div></div>';
  html += '</div>';
  html += '<h4 class="mt14">Etiqueta desta localização</h4>';
  html += '<div class="field-row"><div class="field"><label>Quantidade de etiquetas</label><input type="number" id="f-loc-print-qty" min="1" value="1"></div>';
  html += '<div class="field"><label>Formato da etiqueta</label><select id="f-loc-print-layout"><option value="a4">Folha A4 (etiquetas em grade)</option><option value="thermal">Impressora térmica (rolo)</option></select></div></div>';
  html += '<div class="field" id="f-loc-thermal-width-wrap" style="display:none"><label>Largura da etiqueta térmica</label><select id="f-loc-thermal-width"><option value="40">40mm</option><option value="50">50mm</option><option value="58" selected>58mm</option><option value="80">80mm</option></select></div>';
  html += '<p class="small muted">Ao gerar, o PDF da etiqueta aparece aqui embaixo, pronto — use os botões do próprio visualizador para baixar o arquivo ou imprimir direto (funciona tanto em impressora comum A4 quanto térmica).</p>';
  html += '<div class="mb0"><button type="button" class="btn" id="btn-loc-print">Gerar etiqueta(s)</button></div>';
  html += '<h4 class="mt14">Itens guardados aqui</h4>';
  if(items.length===0) html += emptyState('Nenhum item guardado nesta posição.');
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Quantidade</th></tr></thead><tbody>';
    items.forEach(function(s){ html += '<tr><td>'+esc(productLabel(s.productId, s.variationId))+'</td><td class="qty">'+s.quantity+'</td></tr>'; });
    html += '</tbody></table></div>';
  }
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Fechar</button></div>';
  openModal(html, {wide:true});
  mountQr('loc-qr-'+l.id, l.qrPayload);
  var layoutSel = document.getElementById('f-loc-print-layout');
  layoutSel.addEventListener('change', function(){ document.getElementById('f-loc-thermal-width-wrap').style.display = layoutSel.value==='thermal' ? '' : 'none'; });
  document.getElementById('btn-loc-print').addEventListener('click', function(){
    var qty = Number(document.getElementById('f-loc-print-qty').value)||0;
    if(qty<=0){ toast('Informe uma quantidade válida.','bad'); return; }
    generateAndShowLabelsPdf(l.qrPayload, qty, layoutSel.value, document.getElementById('f-loc-thermal-width').value, l.code, '');
  });
}

/* ============ PRODUTOS ============ */
ROUTES.produtos = function(args){
  if(args && args[0]) return productDetailHtml(args[0]);
  var html = '<div class="toolbar"><div class="toolbar-left"><input type="search" id="f-search-prod" placeholder="Buscar por nome ou SKU…" style="width:260px"></div><button class="btn btn-primary" id="btn-add-prod">+ Novo produto</button></div>';
  if(STATE.products.length===0){
    html += emptyState('Nenhum produto cadastrado. Cadastre pelo recebimento de um pedido de compra ou diretamente aqui.', '<button class="btn btn-primary" id="btn-add-prod-2">+ Novo produto</button>');
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Produto</th><th>Categoria</th><th>Estoque total</th><th></th></tr></thead><tbody id="prod-tbody"></tbody></table></div>';
  }
  return html;
};
function renderProdRows(filter){
  var tbody = document.getElementById('prod-tbody');
  if(!tbody) return;
  var f = (filter||'').toLowerCase();
  var rows = STATE.products.filter(function(p){ return !f || p.name.toLowerCase().indexOf(f)>=0 || p.sku.toLowerCase().indexOf(f)>=0; });
  if(rows.length===0){ tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = rows.map(function(p){
    var cat = findCategory(p.categoryId);
    var total = totalStockForProduct(p.id);
    return '<tr><td class="code-cell">'+esc(p.sku)+'</td><td><a href="#/produtos/'+p.id+'">'+esc(p.name)+'</a></td><td>'+(cat?esc(cat.name):'—')+'</td><td class="qty">'+total+(total===0?' <span class="badge badge-warn">sem estoque</span>':'')+'</td><td class="right"><a class="btn btn-sm" href="#/produtos/'+p.id+'">Ver</a></td></tr>';
  }).join('');
}
ROUTES.produtos__after = function(args){
  if(args && args[0]) { productDetailAfter(args[0]); return; }
  renderProdRows('');
  var add = document.getElementById('btn-add-prod') || document.getElementById('btn-add-prod-2');
  if(add) add.addEventListener('click', function(){ openProductForm(null); });
  var search = document.getElementById('f-search-prod');
  if(search) search.addEventListener('input', function(){ renderProdRows(search.value); });
};

function productDetailHtml(id){
  var p = findProduct(id);
  if(!p) return emptyState('Produto não encontrado.');
  var cat = findCategory(p.categoryId);
  var stockRows = STATE.stock.filter(function(s){return s.productId===id;});
  var movs = STATE.stockMovements.filter(function(m){return m.productId===id;}).slice(0,20);
  var html = '<div class="toolbar"><div><a href="#/produtos" class="small">← Voltar para produtos</a></div>';
  html += '<div class="toolbar-left"><button class="btn btn-sm" id="btn-edit-prod">Editar</button></div></div>';
  html += '<div class="detail-grid">';
  html += '<div class="card"><h3>'+esc(p.name)+'</h3><div class="muted small mt8">SKU '+esc(p.sku)+(cat?' · '+esc(cat.name):'')+(p.brand? ' · '+esc(p.brand):'')+'</div>';
  if(p.variations && p.variations.length){
    html += '<h4 class="mt14">Variações e estoque</h4>';
    html += '<div class="table-wrap"><table><thead><tr><th>Variação</th><th>Total</th></tr></thead><tbody>';
    p.variations.forEach(function(v){ html += '<tr><td>'+esc(v.name)+'</td><td class="qty">'+totalStockForProduct(id, v.id)+'</td></tr>'; });
    html += '</tbody></table></div>';
  } else {
    html += '<div class="stat-line mt14"><span class="k">Estoque total</span><span class="qty">'+totalStockForProduct(id)+'</span></div>';
  }
  html += '<h4 class="mt14">Por localização</h4>';
  if(stockRows.length===0) html += emptyState('Sem estoque em nenhuma localização.');
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Local</th>'+(p.variations&&p.variations.length?'<th>Variação</th>':'')+'<th>Qtd.</th></tr></thead><tbody>';
    stockRows.forEach(function(s){ html += '<tr><td>'+esc(locationLabel(s.locationId))+'</td>'+(p.variations&&p.variations.length? '<td>'+esc(variationName(p,s.variationId)||'—')+'</td>':'')+'<td class="qty">'+s.quantity+'</td></tr>'; });
    html += '</tbody></table></div>';
  }
  html += '</div>';
  html += '<div>'+qrBoxHtml('prod-qr-'+p.id, 'PRD:'+p.id)+'<div class="card mt14"><h4>Histórico recente</h4>';
  if(movs.length===0) html += emptyState('Sem movimentações registradas.');
  else {
    html += '<ul class="timeline">';
    movs.forEach(function(m){ html += '<li><span class="t">'+fmtDate(m.timestamp)+' · '+esc(m.userName)+'</span>'+esc(movTypeLabel(m.type))+' de '+m.quantity+' em '+esc(locationLabel(m.locationId))+(m.note?' — '+esc(m.note):'')+'</li>'; });
    html += '</ul>';
  }
  html += '</div></div>';
  html += '</div>';
  return html;
}
function movTypeLabel(t){ return { entrada:'Entrada', saida:'Saída', ajuste:'Ajuste', transferencia:'Transferência' }[t] || t; }
function productDetailAfter(id){
  mountQr('prod-qr-'+id, 'PRD:'+id);
  var btn = document.getElementById('btn-edit-prod');
  if(btn) btn.addEventListener('click', function(){ openProductForm(findProduct(id)); });
}

var TEMP_VARIATIONS = [];
function openProductForm(product, prefill, onSaved){
  TEMP_VARIATIONS = product && product.variations ? product.variations.slice() : [];
  var html = '<div class="modal-head"><h3>'+(product?'Editar produto':'Novo produto')+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field-row">';
  html += '<div class="field"><label>Nome</label><input type="text" id="f-prod-name" value="'+esc(product?product.name:(prefill&&prefill.name)||'')+'"></div>';
  html += '<div class="field"><label>SKU</label><input type="text" id="f-prod-sku" value="'+esc(product?product.sku:'')+'" placeholder="gerado automaticamente se vazio"></div>';
  html += '</div>';
  html += '<div class="field-row">';
  html += '<div class="field"><label>Categoria</label><select id="f-prod-cat"><option value="">—</option>'+selectOptions(STATE.categories,'id',function(c){return c.name;}, product?product.categoryId:(prefill&&prefill.categoryId))+'</select></div>';
  html += '<div class="field"><label>Marca</label><input type="text" id="f-prod-brand" value="'+esc(product?product.brand||'':'')+'"></div>';
  html += '</div>';
  html += '<div class="field"><label>Preço de venda (opcional, R$)</label><input type="number" step="0.01" min="0" id="f-prod-price" value="'+(product&&product.price?product.price:'')+'"></div>';
  html += '<div class="field"><label>Variações (tamanho, cor, etc. — opcional)</label><div id="var-list"></div>';
  html += '<div class="flex gap8 mt8"><input type="text" id="f-var-new" placeholder="ex: Azul / P" style="flex:1"><button class="btn btn-sm" id="btn-add-var" type="button">+ Adicionar</button></div></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-prod">Salvar</button></div>';
  openModal(html);
  function renderVarList(){
    document.getElementById('var-list').innerHTML = TEMP_VARIATIONS.length===0 ? '<div class="small muted">Nenhuma variação — produto simples.</div>' :
      TEMP_VARIATIONS.map(function(v,i){ return '<span class="badge badge-info" style="margin:2px 4px 2px 0">'+esc(v.name)+' <button type="button" data-rmvar="'+i+'" style="background:none;border:none;color:inherit;cursor:pointer">×</button></span>'; }).join('');
    document.querySelectorAll('[data-rmvar]').forEach(function(b){ b.addEventListener('click', function(){ TEMP_VARIATIONS.splice(Number(b.getAttribute('data-rmvar')),1); renderVarList(); }); });
  }
  renderVarList();
  document.getElementById('btn-add-var').addEventListener('click', function(){
    var inp = document.getElementById('f-var-new');
    var name = inp.value.trim();
    if(name){
      if(TEMP_VARIATIONS.some(function(v){return v.name.toLowerCase()===name.toLowerCase();})){ toast('Já existe uma variação com esse nome.','bad'); return; }
      TEMP_VARIATIONS.push({id:'var-'+Math.random().toString(36).slice(2,9), name:name});
      inp.value=''; renderVarList();
    }
  });
  document.getElementById('save-prod').addEventListener('click', function(){
    var name = document.getElementById('f-prod-name').value.trim();
    if(!name){ toast('Informe o nome do produto.','bad'); return; }
    var sku = document.getElementById('f-prod-sku').value.trim();
    var catId = document.getElementById('f-prod-cat').value || null;
    var brand = document.getElementById('f-prod-brand').value.trim();
    var price = Number(document.getElementById('f-prod-price').value)||0;
    if(product){
      product.name=name; product.categoryId=catId; product.brand=brand; product.variations=TEMP_VARIATIONS; product.price=price;
      if(sku) product.sku=sku;
      addAudit('Editou produto','produto',product.id,name);
      closeModal(); toast('Produto atualizado.','good'); saveState();
      if(onSaved) onSaved(product);
    } else {
      var id = uid('prod');
      if(!sku) sku = 'SKU-'+pad4(STATE.meta.seq.prod-1);
      var p = { id:id, sku:sku, name:name, categoryId:catId, brand:brand, price:price, variations:TEMP_VARIATIONS, createdAt:Date.now() };
      STATE.products.push(p);
      addAudit('Cadastrou produto','produto',id,name);
      closeModal(); toast('Produto cadastrado.','good'); saveState();
      if(onSaved) onSaved(p);
    }
  });
}

/* ============ FORNECEDORES / CLIENTES (genérico) ============ */
function partyModule(kind){ /* kind: 'suppliers' | 'customers' */
  var conf = kind==='suppliers' ? {list:STATE.suppliers, uidKind:'sup', noun:'fornecedor'} : {list:STATE.customers, uidKind:'cus', noun:'cliente'};
  return conf;
}
ROUTES.fornecedores = function(){ return partyListHtml('suppliers'); };
ROUTES.clientes = function(){ return partyListHtml('customers'); };
function partyListHtml(kind){
  var conf = partyModule(kind);
  var html = '<div class="toolbar"><div></div><button class="btn btn-primary" id="btn-add-party">+ Novo '+conf.noun+'</button></div>';
  if(conf.list.length===0) html += emptyState('Nenhum '+conf.noun+' cadastrado.', '<button class="btn btn-primary" id="btn-add-party-2">+ Novo '+conf.noun+'</button>');
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Nome</th><th>Contato</th><th>Telefone</th><th></th></tr></thead><tbody>';
    conf.list.forEach(function(c){
      html += '<tr><td>'+esc(c.name)+'</td><td>'+esc(c.contact||'—')+'</td><td>'+esc(c.phone||'—')+'</td><td class="right"><button class="btn btn-sm" data-edit-party="'+c.id+'">Editar</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
}
ROUTES.fornecedores__after = function(){ partyAfter('suppliers'); };
ROUTES.clientes__after = function(){ partyAfter('customers'); };
function partyAfter(kind){
  var conf = partyModule(kind);
  var add = document.getElementById('btn-add-party') || document.getElementById('btn-add-party-2');
  if(add) add.addEventListener('click', function(){ openPartyForm(kind, null); });
  document.querySelectorAll('[data-edit-party]').forEach(function(b){ b.addEventListener('click', function(){ openPartyForm(kind, byId(conf.list, b.getAttribute('data-edit-party'))); }); });
}
function openPartyForm(kind, item, onSaved){
  var conf = partyModule(kind);
  var html = '<div class="modal-head"><h3>'+(item?'Editar ':'Novo ')+conf.noun+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field"><label>Nome</label><input type="text" id="f-party-name" value="'+(item?esc(item.name):'')+'"></div>';
  html += '<div class="field-row"><div class="field"><label>Contato</label><input type="text" id="f-party-contact" value="'+(item?esc(item.contact||''):'')+'"></div>';
  html += '<div class="field"><label>Telefone</label><input type="text" id="f-party-phone" value="'+(item?esc(item.phone||''):'')+'"></div></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-party">Salvar</button></div>';
  openModal(html);
  document.getElementById('save-party').addEventListener('click', function(){
    var name = document.getElementById('f-party-name').value.trim();
    if(!name){ toast('Informe o nome.','bad'); return; }
    var contact = document.getElementById('f-party-contact').value.trim();
    var phone = document.getElementById('f-party-phone').value.trim();
    if(item){ item.name=name; item.contact=contact; item.phone=phone; addAudit('Editou '+conf.noun, conf.noun, item.id, name); closeModal(); toast('Salvo.','good'); saveState(); if(onSaved) onSaved(item); }
    else {
      var id = uid(conf.uidKind);
      var obj = { id:id, name:name, contact:contact, phone:phone };
      conf.list.push(obj);
      addAudit('Cadastrou '+conf.noun, conf.noun, id, name);
      closeModal(); toast('Cadastrado.','good'); saveState();
      if(onSaved) onSaved(obj);
    }
  });
}

/* ============ COMPRAS ============ */
ROUTES.compras = function(args){
  if(args && args[0]) return purchaseOrderDetailHtml(args[0]);
  var html = '<div class="toolbar"><div></div><button class="btn btn-primary" id="btn-add-po">+ Novo pedido de compra</button></div>';
  if(STATE.purchaseOrders.length===0) html += emptyState('Nenhum pedido de compra registrado.', '<button class="btn btn-primary" id="btn-add-po-2">+ Novo pedido de compra</button>');
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Fornecedor</th><th>Itens</th><th>Previsão</th><th>Status</th><th></th></tr></thead><tbody>';
    STATE.purchaseOrders.slice().reverse().forEach(function(po){
      var sup = findSupplier(po.supplierId);
      html += '<tr><td class="code-cell">'+esc(po.code)+'</td><td>'+(sup?esc(sup.name):'—')+'</td><td>'+po.items.length+'</td><td>'+fmtDateOnly(po.expectedDate)+'</td><td>'+statusBadge(po.status)+'</td><td class="right"><a class="btn btn-sm" href="#/compras/'+po.id+'">Ver</a></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
};
ROUTES.compras__after = function(args){
  if(args && args[0]){ purchaseOrderDetailAfter(args[0]); return; }
  var add = document.getElementById('btn-add-po') || document.getElementById('btn-add-po-2');
  if(add) add.addEventListener('click', openPurchaseOrderForm);
};

var TEMP_PO_ITEMS = [];
function openPurchaseOrderForm(){
  TEMP_PO_ITEMS = [];
  renderPOModal();
}
function renderPOModal(){
  var html = '<div class="modal-head"><h3>Novo pedido de compra</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field-row">';
  html += '<div class="field"><label>Fornecedor</label><div class="flex gap8"><select id="f-po-supplier" style="flex:1"><option value="">Selecione…</option>'+selectOptions(STATE.suppliers,'id',function(s){return s.name;})+'</select><button class="btn btn-sm" type="button" id="btn-quick-sup">+ Novo</button></div></div>';
  html += '<div class="field"><label>Data prevista</label><input type="date" id="f-po-date"></div>';
  html += '</div>';
  html += '<h4>Itens</h4><div id="po-items"></div>';
  html += '<button class="btn btn-sm" type="button" id="btn-po-add-item">+ Adicionar item</button>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-po">Criar pedido</button></div>';
  openModal(html, {wide:true});
  document.getElementById('btn-quick-sup').addEventListener('click', function(){ openPartyForm('suppliers', null, function(s){ renderPOModal(); setTimeout(function(){ document.getElementById('f-po-supplier').value = s.id; },0); }); });
  document.getElementById('btn-po-add-item').addEventListener('click', function(){ TEMP_PO_ITEMS.push({key:Math.random().toString(36).slice(2,8), mode:'existing', productId:'', variationId:'', newName:'', qty:1}); renderPoItemRows(); });
  document.getElementById('save-po').addEventListener('click', submitPurchaseOrder);
  renderPoItemRows();
}
function renderPoItemRows(){
  var wrap = document.getElementById('po-items');
  if(!wrap) return;
  if(TEMP_PO_ITEMS.length===0){ wrap.innerHTML = '<div class="small muted mt8">Nenhum item adicionado ainda.</div>'; return; }
  wrap.innerHTML = TEMP_PO_ITEMS.map(function(it, idx){
    var row = '<div class="card" style="padding:12px;margin-bottom:8px;">';
    row += '<div class="flex gap8 items-center mb0"><label class="mb0" style="flex:1">Item '+(idx+1)+'</label><button type="button" class="btn btn-sm btn-ghost" data-rm-item="'+idx+'">Remover</button></div>';
    row += '<div class="pill-tabs" style="margin:8px 0"><button type="button" class="pill-tab'+(it.mode==='existing'?' active':'')+'" data-mode="existing" data-idx="'+idx+'">Produto existente</button><button type="button" class="pill-tab'+(it.mode==='new'?' active':'')+'" data-mode="new" data-idx="'+idx+'">Produto novo</button></div>';
    if(it.mode==='existing'){
      var p = findProduct(it.productId);
      row += '<div class="field-row"><div class="field"><label>Produto</label><select data-f="productId" data-idx="'+idx+'"><option value="">Selecione…</option>'+selectOptions(STATE.products,'id',function(pp){return pp.sku+' — '+pp.name;}, it.productId)+'</select></div>';
      if(p && p.variations && p.variations.length){
        row += '<div class="field"><label>Variação</label><select data-f="variationId" data-idx="'+idx+'"><option value="">—</option>'+selectOptions(p.variations,'id',function(v){return v.name;}, it.variationId)+'</select></div>';
      } else { row += '<div class="field"><label>Quantidade</label><input type="number" min="1" value="'+it.qty+'" data-f="qty" data-idx="'+idx+'"></div>'; }
      row += '</div>';
      if(p && p.variations && p.variations.length) row += '<div class="field"><label>Quantidade</label><input type="number" min="1" value="'+it.qty+'" data-f="qty" data-idx="'+idx+'"></div>';
    } else {
      row += '<div class="field-row"><div class="field"><label>Nome do produto novo</label><input type="text" data-f="newName" data-idx="'+idx+'" value="'+esc(it.newName)+'"></div>';
      row += '<div class="field"><label>Categoria</label><select data-f="newCategoryId" data-idx="'+idx+'"><option value="">—</option>'+selectOptions(STATE.categories,'id',function(c){return c.name;}, it.newCategoryId)+'</select></div></div>';
      row += '<div class="field"><label>Quantidade</label><input type="number" min="1" value="'+it.qty+'" data-f="qty" data-idx="'+idx+'"></div>';
    }
    row += '</div>';
    return row;
  }).join('');
  wrap.querySelectorAll('[data-mode]').forEach(function(b){ b.addEventListener('click', function(){ TEMP_PO_ITEMS[Number(b.getAttribute('data-idx'))].mode = b.getAttribute('data-mode'); renderPoItemRows(); }); });
  wrap.querySelectorAll('[data-rm-item]').forEach(function(b){ b.addEventListener('click', function(){ TEMP_PO_ITEMS.splice(Number(b.getAttribute('data-rm-item')),1); renderPoItemRows(); }); });
  wrap.querySelectorAll('[data-f]').forEach(function(el){
    el.addEventListener('change', function(){
      var idx = Number(el.getAttribute('data-idx')); var f = el.getAttribute('data-f');
      TEMP_PO_ITEMS[idx][f] = (f==='qty') ? Number(el.value) : el.value;
      if(f==='productId') renderPoItemRows();
    });
  });
}
function submitPurchaseOrder(){
  var supplierId = document.getElementById('f-po-supplier').value;
  var date = document.getElementById('f-po-date').value;
  if(!supplierId){ toast('Selecione um fornecedor.','bad'); return; }
  if(TEMP_PO_ITEMS.length===0){ toast('Adicione ao menos um item.','bad'); return; }
  for(var i=0;i<TEMP_PO_ITEMS.length;i++){
    var it = TEMP_PO_ITEMS[i];
    if(it.mode==='existing' && !it.productId){ toast('Selecione o produto do item '+(i+1)+'.','bad'); return; }
    if(it.mode==='new' && !it.newName){ toast('Informe o nome do produto novo no item '+(i+1)+'.','bad'); return; }
    if(!it.qty || it.qty<=0){ toast('Informe a quantidade do item '+(i+1)+'.','bad'); return; }
  }
  var id = uid('po');
  var code = 'OC-'+pad4(STATE.meta.seq.po-1);
  var items = TEMP_PO_ITEMS.map(function(it){
    return { id:uid('poi'), isNew: it.mode==='new', productId: it.mode==='existing'? it.productId : null,
      variationId: it.variationId||null, newName: it.newName||'', newCategoryId: it.newCategoryId||null,
      qtyOrdered: it.qty, qtyReceived: 0 };
  });
  STATE.purchaseOrders.push({ id:id, code:code, supplierId:supplierId, items:items, status:'AGUARDANDO_RECEBIMENTO', expectedDate: date? new Date(date).getTime(): null, createdAt: Date.now(), createdBy: currentUser()? currentUser().id : null });
  addAudit('Criou pedido de compra','pedido_compra',id,code);
  closeModal(); toast('Pedido de compra criado.','good'); saveState();
  setRoute('/compras/'+id);
}

function purchaseOrderDetailHtml(id){
  var po = findPO(id);
  if(!po) return emptyState('Pedido não encontrado.');
  var sup = findSupplier(po.supplierId);
  var html = '<div class="toolbar"><a href="#/compras" class="small">← Voltar</a></div>';
  html += '<div class="card"><div class="flex" style="justify-content:space-between"><div><h3>'+esc(po.code)+'</h3><div class="muted small">Fornecedor: '+(sup?esc(sup.name):'—')+' · Previsão: '+fmtDateOnly(po.expectedDate)+'</div></div>'+statusBadge(po.status)+'</div>';
  html += '<div class="table-wrap mt14"><table><thead><tr><th>Produto</th><th>Pedido</th><th>Recebido</th></tr></thead><tbody>';
  po.items.forEach(function(it){
    var label = it.isNew ? esc(it.newName)+' <span class="badge badge-accent">produto novo</span>' : esc(productLabel(it.productId, it.variationId));
    html += '<tr><td>'+label+'</td><td class="qty">'+it.qtyOrdered+'</td><td class="qty">'+it.qtyReceived+'</td></tr>';
  });
  html += '</tbody></table></div>';
  if(po.status==='AGUARDANDO_RECEBIMENTO'){
    html += '<div class="mt14"><button class="btn btn-primary" id="btn-confirm-recv">Iniciar recebimento</button></div>';
  }
  if(po.status==='RECEBIMENTO_COM_DIVERGENCIA' || po.status==='RECEBIDO'){
    var pend = STATE.storageTasks.filter(function(t){return t.poId===po.id && t.status==='PENDENTE';}).length;
    html += '<div class="readonly-banner" style="background:var(--info-bg);color:var(--text);border-color:var(--border)" class="mt14">'+(pend>0? pend+' item(ns) aguardando armazenagem (armazenamento é feito no sistema coletor).' : 'Recebimento confirmado.')+'</div>';
  }
  if(po.status==='ARMAZENADO'){
    html += '<div class="mt14"><button class="btn btn-primary" id="btn-conclude-po">Concluir pedido</button></div>';
  }
  html += '</div>';
  return html;
}
function purchaseOrderDetailAfter(id){
  var po = findPO(id);
  if(!po) return;
  var confirmBtn = document.getElementById('btn-confirm-recv');
  if(confirmBtn) confirmBtn.addEventListener('click', function(){ openReceivingWizard(po); });
  var concludeBtn = document.getElementById('btn-conclude-po');
  if(concludeBtn) concludeBtn.addEventListener('click', function(){ po.status='CONCLUIDO'; addAudit('Concluiu pedido de compra','pedido_compra',po.id,po.code); toast('Pedido concluído.','good'); saveState(); });
}

/* ============ RECEBIMENTO — tela dedicada (lista) ============
   Tela própria no menu (grupo "Compras" → "Recebimento"), separada da tela
   "Pedidos de compra": reúne, num só lugar, todos os pedidos aguardando
   recebimento e dá o botão "Iniciar recebimento" direto na linha, sem
   precisar abrir o pedido primeiro. Ao lado, mantém uma lista de referência
   dos pedidos recebidos recentemente (com link para o pedido, caso seja
   preciso reimprimir etiquetas ou conferir o que já foi recebido).
   De propósito, esta tela NÃO tem nenhum atalho para criar um pedido de
   compra novo — cada função fica isolada na sua própria tela; criar pedido
   de compra é só em "Pedidos de compra". */
ROUTES.recebimento = function(){
  var pending = STATE.purchaseOrders.filter(function(p){ return p.status==='AGUARDANDO_RECEBIMENTO'; });
  var concluded = STATE.purchaseOrders.filter(function(p){ return p.status==='RECEBIMENTO_COM_DIVERGENCIA' || p.status==='RECEBIDO' || p.status==='ARMAZENADO' || p.status==='CONCLUIDO'; }).slice().reverse().slice(0,10);
  var html = '<p class="muted small mb0">Para cada item do pedido, em três passos separados: 1) confirme se ele chegou ou não; 2) confira a quantidade e a variedade recebidas; 3) imprima o QR Code de cada unidade — o mesmo código já cadastrado no produto — para colar antes de guardar. Ao final do pedido, dá pra imprimir de uma vez as etiquetas de todos os itens.</p>';
  html += '<h3 class="mt14">Aguardando recebimento</h3>';
  if(pending.length===0){
    html += emptyState('Nenhum pedido de compra aguardando recebimento no momento. Para criar um novo pedido de compra, use a tela "Pedidos de compra".');
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Fornecedor</th><th>Itens</th><th>Previsão</th><th></th></tr></thead><tbody>';
    pending.forEach(function(po){
      var sup = findSupplier(po.supplierId);
      html += '<tr><td class="code-cell">'+esc(po.code)+'</td><td>'+(sup?esc(sup.name):'—')+'</td><td>'+po.items.length+'</td><td>'+fmtDateOnly(po.expectedDate)+'</td><td class="right"><button class="btn btn-sm btn-primary" data-recv-po="'+po.id+'">Iniciar recebimento</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  if(concluded.length>0){
    html += '<h3 class="mt14">Recebimentos concluídos</h3>';
    html += '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Fornecedor</th><th>Status</th><th></th></tr></thead><tbody>';
    concluded.forEach(function(po){
      var sup = findSupplier(po.supplierId);
      html += '<tr><td class="code-cell">'+esc(po.code)+'</td><td>'+(sup?esc(sup.name):'—')+'</td><td>'+statusBadge(po.status)+'</td><td class="right"><a class="btn btn-sm" href="#/compras/'+po.id+'">Ver pedido</a></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
};
ROUTES.recebimento__after = function(){
  document.querySelectorAll('[data-recv-po]').forEach(function(b){ b.addEventListener('click', function(){
    var po = findPO(b.getAttribute('data-recv-po'));
    if(po) openReceivingWizard(po);
  }); });
};

/* ============ RECEBIMENTO — assistente item a item + impressão de QR Codes ============
   Tela dedicada (modal em três abas separadas por item, uma atividade por
   aba): (1) "Confirmar chegada" — Sim/Não; se "Não", o item fica com 0
   unidades recebidas, sem impressão, e o pedido segue como divergência; só
   com "Sim" a aba 2 libera. (2) "Conferir quantidade" — confere/ajusta a
   quantidade recebida (comparando com a pedida) e confirma que a variedade
   bate com o pedido; só então a aba 3 libera. (3) "Imprimir QR Codes" — na
   quantidade exata confirmada, em folha A4 ou impressora térmica (a escolha
   da impressora em si é feita na janela nativa de impressão do navegador,
   então funciona com qualquer impressora instalada no computador/celular,
   inclusive "Salvar como PDF"). O mesmo código ('PRD:'+id do produto) já é o
   que o sistema coletor usa para bipagem de separação/armazenagem, então a
   etiqueta impressa aqui funciona sem nenhuma mudança nesse outro sistema.
   Depois do último item, uma tela final (renderReceivingFinish) reúne todos
   os itens recebidos e oferece um atalho para imprimir de uma vez as
   etiquetas de todos eles — só aí "Concluir recebimento" fecha o pedido. */
var RECV_WIZ = null; /* { po, idx, tab: 'arrival'|'confirm'|'print', arrived } */
function openReceivingWizard(po){
  var pendingNewProducts = po.items.filter(function(it){ return it.isNew && !it.productId; });
  if(pendingNewProducts.length>0){
    var pit = pendingNewProducts[0];
    openProductForm(null, {name:pit.newName, categoryId:pit.newCategoryId}, function(newProduct){
      pit.productId = newProduct.id;
      setTimeout(function(){ openReceivingWizard(po); }, 0);
    });
    return;
  }
  po.items.forEach(function(it){ it.qtyReceived = it.qtyOrdered; });
  RECV_WIZ = { po: po, idx: 0, tab: 'arrival', arrived: true };
  renderReceivingStep();
}
function finalizeReceiving(po){
  var anyDivergence = false;
  po.items.forEach(function(it){
    var qty = it.qtyReceived||0;
    if(qty < it.qtyOrdered) anyDivergence = true;
    if(qty > 0){
      var existingLoc = locationsForProduct(it.productId, it.variationId)[0];
      var suggestion = existingLoc ? findLocation(existingLoc.locationId) : suggestLocationForNewItem();
      STATE.storageTasks.push({ id:uid('storage'), poId:po.id, poItemId:it.id, productId:it.productId, variationId:it.variationId,
        qtyPending: qty, suggestedLocationId: suggestion? suggestion.id : null, status:'PENDENTE' });
    }
  });
  po.status = anyDivergence ? 'RECEBIMENTO_COM_DIVERGENCIA' : 'RECEBIDO';
  addAudit('Confirmou recebimento','pedido_compra',po.id, po.code+(anyDivergence?' (com divergência)':''));
  RECV_WIZ = null;
  closeModal(); toast('Recebimento confirmado.','good'); saveState();
}
/* Tela final do assistente, depois do último item: reúne os itens com
   alguma quantidade recebida e oferece um atalho para imprimir de uma vez
   as etiquetas de QR Code de TODOS eles (em vez de precisar repetir a etapa
   "Imprimir QR Codes" item por item — que continua disponível durante o
   assistente, para quem preferir ir imprimindo aos poucos). Só depois de
   passar por aqui (imprimindo tudo ou não) é que "Concluir recebimento"
   fecha o pedido de verdade. */
function renderReceivingFinish(po){
  var itemsToLabel = po.items.filter(function(it){ return (it.qtyReceived||0) > 0; });
  var totalQty = itemsToLabel.reduce(function(s,it){ return s + (it.qtyReceived||0); }, 0);
  var html = '<div class="modal-head"><h3>Recebimento — '+esc(po.code)+' · imprimir etiquetas</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<p class="small muted">Todos os itens deste pedido já foram conferidos. Antes de concluir, você pode imprimir de uma vez as etiquetas de QR Code de todos os itens recebidos.</p>';
  if(itemsToLabel.length===0){
    html += '<div class="readonly-banner" style="background:var(--info-bg);color:var(--text);border-color:var(--border)">Nenhum item foi recebido neste pedido — não há etiquetas para imprimir.</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Etiquetas</th></tr></thead><tbody>';
    itemsToLabel.forEach(function(it){
      var label = it.isNew ? it.newName : productLabel(it.productId, it.variationId);
      html += '<tr><td>'+esc(label)+'</td><td class="qty">'+it.qtyReceived+'</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<p class="small muted mt14">Total: '+totalQty+' etiqueta(s).</p>';
    html += '<div class="field-row"><div class="field"><label>Formato da etiqueta</label><select id="f-print-all-layout"><option value="a4">Folha A4 (etiquetas em grade)</option><option value="thermal">Impressora térmica (rolo)</option></select></div>';
    html += '<div class="field" id="f-print-all-thermal-wrap" style="display:none"><label>Largura da etiqueta térmica</label><select id="f-print-all-thermal-width"><option value="40">40mm</option><option value="50">50mm</option><option value="58" selected>58mm</option><option value="80">80mm</option><option value="100">100mm</option></select></div></div>';
    html += '<p class="small muted">Ao clicar em gerar, o PDF com as etiquetas aparece aqui embaixo, pronto — use os botões do próprio visualizador de PDF para baixar o arquivo ou imprimir direto (funciona tanto em impressora comum A4 quanto térmica).</p>';
    html += '<div class="mb0"><button type="button" class="btn btn-primary" id="btn-recv-print-all">Imprimir todas as etiquetas ('+totalQty+')</button></div>';
  }
  html += '<div class="modal-foot"><button class="btn" id="btn-recv-finish-back">← Voltar ao último item</button><button class="btn'+(itemsToLabel.length===0?' btn-primary':'')+'" id="btn-recv-finish-conclude">Concluir recebimento</button></div>';
  openModal(html, {wide:true});

  if(itemsToLabel.length>0){
    var layoutSel = document.getElementById('f-print-all-layout');
    layoutSel.addEventListener('change', function(){ document.getElementById('f-print-all-thermal-wrap').style.display = layoutSel.value==='thermal' ? '' : 'none'; });
    document.getElementById('btn-recv-print-all').addEventListener('click', function(){
      var entries = itemsToLabel.map(function(it){
        var product = it.productId ? findProduct(it.productId) : null;
        var label = it.isNew ? it.newName : productLabel(it.productId, it.variationId);
        return { code: 'PRD:'+it.productId, qty: it.qtyReceived, name: label, sku: product?product.sku:'' };
      });
      generateAndShowBatchLabelsPdf(entries, layoutSel.value, document.getElementById('f-print-all-thermal-width').value);
    });
  }
  document.getElementById('btn-recv-finish-back').addEventListener('click', function(){
    var w = RECV_WIZ; if(!w) return;
    w.idx = Math.max(0, po.items.length-1); w.tab = 'print'; w.arrived = true;
    renderReceivingStep();
  });
  document.getElementById('btn-recv-finish-conclude').addEventListener('click', function(){ finalizeReceiving(po); });
}
function renderReceivingStep(){
  var w = RECV_WIZ; if(!w) return;
  var po = w.po;
  if(w.idx >= po.items.length){ renderReceivingFinish(po); return; }
  var it = po.items[w.idx];
  var product = it.productId ? findProduct(it.productId) : null;
  var label = it.isNew ? it.newName : productLabel(it.productId, it.variationId);
  if(it.qtyReceived===undefined || it.qtyReceived===null) it.qtyReceived = it.qtyOrdered;
  if(w.arrived===undefined) w.arrived = true;
  /* passo "Conferir quantidade" e "Imprimir QR Codes" só fazem sentido depois
     de confirmada a chegada — se por algum motivo a tela ficar num desses
     passos sem chegada confirmada como "sim", volta pro passo 1 (segurança). */
  if((w.tab==='confirm' || w.tab==='print') && !w.arrived) w.tab = 'arrival';

  var html = '<div class="modal-head"><h3>Recebimento — '+esc(po.code)+' · item '+(w.idx+1)+'/'+po.items.length+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="card" style="padding:12px"><div style="font-weight:600;font-size:15px">'+esc(label)+'</div>';
  if(product) html += '<div class="small muted">SKU: '+esc(product.sku)+'</div>';
  html += '<div class="small muted mt8">Quantidade pedida: <strong class="qty">'+it.qtyOrdered+'</strong></div></div>';

  html += '<div class="pill-tabs" style="margin:12px 0">';
  html += '<button type="button" class="pill-tab'+(w.tab==='arrival'?' active':'')+'" data-tab="arrival">1. Confirmar chegada</button>';
  html += '<button type="button" class="pill-tab'+(w.tab==='confirm'?' active':'')+'" data-tab="confirm">2. Conferir quantidade</button>';
  html += '<button type="button" class="pill-tab'+(w.tab==='print'?' active':'')+'" data-tab="print">3. Imprimir QR Codes</button>';
  html += '</div>';

  if(w.tab==='arrival'){
    html += '<div class="field"><label>Este item do pedido chegou?</label><div class="pill-tabs" style="margin:0">';
    html += '<button type="button" class="pill-tab'+(w.arrived?' active':'')+'" data-arrived="yes">Sim, chegou</button>';
    html += '<button type="button" class="pill-tab'+(!w.arrived?' active':'')+'" data-arrived="no">Não chegou</button>';
    html += '</div></div>';
    if(!w.arrived) html += '<div class="readonly-banner mt14" style="background:var(--warn-bg);color:var(--warn);border-color:var(--warn)">Este item vai ficar marcado como não recebido (0 unidades) — o pedido ficará com divergência e nenhum QR Code será impresso para ele agora. Dá pra voltar aqui depois quando o item chegar.</div>';
    html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="btn-recv-confirm-arrival">'+(w.arrived?'Confirmar chegada →':'Confirmar que não chegou →')+'</button></div>';
  } else if(w.tab==='confirm'){
    var vn = variationName(product, it.variationId);
    html += '<div class="field"><label>Quantidade recebida agora</label><input type="number" id="f-recv-qty" min="0" value="'+it.qtyReceived+'"></div>';
    html += '<div class="field"><label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" id="f-recv-variety-ok" checked style="width:auto"> Confirmo que a variedade recebida'+(vn?' — <strong>'+esc(vn)+'</strong>':'')+' — bate com o que foi pedido</label></div>';
    if(Number(it.qtyReceived) < it.qtyOrdered) html += '<div class="readonly-banner" style="background:var(--bad-bg);color:var(--bad);border-color:var(--bad)">Quantidade menor que a pedida — este pedido ficará com divergência.</div>';
    html += '<div class="modal-foot"><button class="btn" id="btn-recv-back-arrival">← Voltar</button><button class="btn btn-primary" id="btn-recv-confirm-qty">Confirmar quantidade e variedade →</button></div>';
  } else {
    html += '<p class="small muted">Gere '+it.qtyReceived+' QR Code(s) deste item — um para colar em cada unidade recebida, antes de guardar. É o mesmo código que será bipado depois na separação.</p>';
    html += '<div class="field-row"><div class="field"><label>Formato da etiqueta</label><select id="f-print-layout"><option value="a4">Folha A4 (etiquetas em grade)</option><option value="thermal">Impressora térmica (rolo)</option></select></div>';
    html += '<div class="field" id="f-thermal-width-wrap" style="display:none"><label>Largura da etiqueta térmica</label><select id="f-thermal-width"><option value="40">40mm</option><option value="50">50mm</option><option value="58" selected>58mm</option><option value="80">80mm</option><option value="100">100mm</option></select></div></div>';
    html += '<p class="small muted">Ao clicar em gerar, o PDF com as etiquetas aparece aqui embaixo, pronto — use os botões do próprio visualizador de PDF para baixar o arquivo ou imprimir direto (funciona tanto em impressora comum A4 quanto térmica).</p>';
    html += '<div class="modal-foot"><button class="btn" id="btn-recv-back">← Voltar</button><button class="btn" id="btn-recv-print">Gerar '+it.qtyReceived+' QR Code(s)</button><button class="btn btn-primary" id="btn-recv-next">'+(w.idx+1<po.items.length?'Próximo item →':'Ver resumo e concluir →')+'</button></div>';
  }

  openModal(html, {wide:true});

  document.querySelectorAll('[data-tab]').forEach(function(b){
    b.addEventListener('click', function(){
      var target = b.getAttribute('data-tab');
      if((target==='confirm' || target==='print') && !w.arrived){ toast('Confirme primeiro se o item chegou.','bad'); return; }
      if(w.tab==='confirm'){
        var q = document.getElementById('f-recv-qty');
        if(q && !isNaN(Number(q.value))) it.qtyReceived = Number(q.value);
      }
      w.tab = target; renderReceivingStep();
    });
  });

  if(w.tab==='arrival'){
    document.querySelectorAll('[data-arrived]').forEach(function(b){
      b.addEventListener('click', function(){ w.arrived = b.getAttribute('data-arrived')==='yes'; renderReceivingStep(); });
    });
    document.getElementById('btn-recv-confirm-arrival').addEventListener('click', function(){
      if(w.arrived){ w.tab = 'confirm'; renderReceivingStep(); }
      else {
        it.qtyReceived = 0;
        w.idx += 1; w.arrived = true; w.tab = 'arrival'; renderReceivingStep();
      }
    });
  } else if(w.tab==='confirm'){
    document.getElementById('btn-recv-back-arrival').addEventListener('click', function(){ w.tab='arrival'; renderReceivingStep(); });
    document.getElementById('btn-recv-confirm-qty').addEventListener('click', function(){
      var qty = Number(document.getElementById('f-recv-qty').value);
      if(isNaN(qty) || qty<0){ toast('Informe uma quantidade válida.','bad'); return; }
      if(!document.getElementById('f-recv-variety-ok').checked){ toast('Confirme que a variedade recebida bate com o pedido — ou volte e marque "Não chegou" se o item estiver errado.','bad'); return; }
      it.qtyReceived = qty;
      w.tab = 'print'; renderReceivingStep();
    });
  } else {
    var layoutSel = document.getElementById('f-print-layout');
    layoutSel.addEventListener('change', function(){ document.getElementById('f-thermal-width-wrap').style.display = layoutSel.value==='thermal' ? '' : 'none'; });
    document.getElementById('btn-recv-back').addEventListener('click', function(){ w.tab='confirm'; renderReceivingStep(); });
    document.getElementById('btn-recv-print').addEventListener('click', function(){
      if(!it.qtyReceived || it.qtyReceived<=0){ toast('Quantidade recebida precisa ser maior que zero para imprimir.','bad'); return; }
      if(!product){ toast('Produto não encontrado.','bad'); return; }
      generateAndShowLabelsPdf('PRD:'+product.id, it.qtyReceived, layoutSel.value, document.getElementById('f-thermal-width').value, label, product.sku);
    });
    document.getElementById('btn-recv-next').addEventListener('click', function(){
      w.idx += 1; w.arrived = true; w.tab = 'arrival'; renderReceivingStep();
    });
  }
}
/* Mecanismo de ÚLTIMO RECURSO, só usado quando o QR Code ou o jsPDF não
   carregam (ex.: falha de rede): gera `qty` etiquetas com QR Code num
   #print-area oculto e chama window.print() na própria janela — de
   propósito, NÃO abre uma nova janela/aba (window.open), porque o Artifact
   publicado roda dentro de um iframe sandboxed sem allow-popups. Esse mesmo
   sandbox também falta o allow-modals necessário para
   window.print()/alert()/confirm(), então essa chamada pode ser ignorada
   silenciosamente — por isso o caminho principal agora é
   generateAndShowLabelsPdf() (acima), que embute um PDF de verdade no modal,
   sem depender de window.print() nem de nenhuma permissão do sandbox. Esta
   função só é chamada quando o PDF em si não pôde ser gerado.
   `code` é o texto codificado no QR; `name`/`sku` são só o texto impresso
   embaixo da etiqueta (sku é opcional — ex.: localizações não têm SKU). */
function printQrLabels(code, qty, layout, thermalWidthMm, name, sku){
  qty = Math.max(1, Math.min(500, Math.floor(Number(qty))||0));
  var area = document.getElementById('print-area');
  if(!area){ area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
  var pageStyle = document.getElementById('print-page-style');
  if(!pageStyle){ pageStyle = document.createElement('style'); pageStyle.id = 'print-page-style'; document.head.appendChild(pageStyle); }

  sku = sku || '';
  name = name || '';
  var thermalPx = (Number(thermalWidthMm)||58) * 2;

  var labelsHtml = '';
  for(var i=0;i<qty;i++){
    labelsHtml += '<div class="label-'+(layout==='a4'?'a4':'thermal')+'"><div class="label-qr" id="print-qr-'+i+'"></div><div class="label-name">'+esc(name)+'</div>'+(sku?'<div class="label-code">'+esc(sku)+'</div>':'')+'</div>';
  }
  area.className = layout==='a4' ? 'print-sheet-a4' : 'print-sheet-thermal';
  area.innerHTML = labelsHtml;

  pageStyle.textContent = layout==='a4' ? '@page { size: A4; margin: 10mm; }' : '@page { size: '+(Number(thermalWidthMm)||58)+'mm auto; margin: 2mm; }';

  ensureQrLib(function(ok){
    for(var i=0;i<qty;i++){
      (function(i){
        var el = document.getElementById('print-qr-'+i);
        if(!el) return;
        if(ok && window.QRCode){
          try{ new QRCode(el, { text: code, width: layout==='a4'?110:thermalPx, height: layout==='a4'?110:thermalPx, correctLevel: QRCode.CorrectLevel.M }); }
          catch(e){ el.textContent = code; }
        } else {
          el.textContent = code;
        }
      })(i);
    }
    setTimeout(function(){ showPrintPreview(qty); }, 150);
  });
}
/* window.print() sozinho não é confiável aqui: o Artifact publicado roda num
   iframe com sandbox="allow-scripts allow-same-origin allow-forms" (sem
   allow-modals) — confirmado inspecionando o próprio iframe — e por
   especificação, sem allow-modals o navegador ignora silenciosamente
   window.print()/alert()/confirm(). Por isso esta função só entra em cena
   como fallback de ÚLTIMO RECURSO (quando o PDF embutido de
   generateAndShowLabelsPdf()/generateAndShowBatchLabelsPdf() não pôde ser
   gerado): mostramos as etiquetas já prontas na própria tela (dentro do
   modal aberto), com instruções para o disparo manual do navegador
   (Ctrl+P/Cmd+P, ou o menu de impressão no celular) — que funciona
   independentemente do sandbox, porque é uma ação do usuário, não um
   script. Ainda tentamos window.print() de brinde (pode funcionar em outros
   contextos), mas nunca dependemos dele. */
function showPrintPreview(qty){
  var modal = document.querySelector('.modal');
  var old = document.getElementById('print-preview-inline');
  if(old) old.remove();
  if(modal){
    var wrap = document.createElement('div');
    wrap.id = 'print-preview-inline';
    wrap.style.marginTop = '14px';
    var banner = document.createElement('div');
    banner.className = 'readonly-banner';
    banner.style.background = 'var(--accent-bg)'; banner.style.color = 'var(--accent)'; banner.style.borderColor = 'var(--accent)';
    banner.innerHTML = '<strong>'+qty+' etiqueta(s) pronta(s)</strong> — para imprimir agora: no computador, aperte <strong>Ctrl+P</strong> (Windows/Linux) ou <strong>Cmd+P</strong> (Mac); no celular, abra o menu do navegador (⋮ ou compartilhar) e toque em "Imprimir". A página já sai ajustada, só com as etiquetas.';
    wrap.appendChild(banner);
    var area = document.getElementById('print-area');
    if(area){
      var clone = area.cloneNode(true);
      clone.removeAttribute('id');
      clone.style.cssText = 'max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff;margin-top:8px';
      wrap.appendChild(clone);
    }
    var foot = modal.querySelector('.modal-foot');
    if(foot) modal.insertBefore(wrap, foot); else modal.appendChild(wrap);
    try{ wrap.scrollIntoView({behavior:'smooth', block:'nearest'}); }catch(e){}
  }
  try{ window.print(); }catch(e){ /* esperado neste ambiente sandboxed — as instruções acima já cobrem o caminho manual */ }
}

/* ============ ESTOQUE / MOVIMENTAÇÕES ============ */
ROUTES.estoque = function(){
  if(STATE.stock.length===0) return emptyState('Nenhum estoque registrado ainda.');
  var html = '<div class="toolbar"><input type="search" id="f-search-stock" placeholder="Buscar produto…" style="width:260px"></div>';
  html += '<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Localização</th><th>Quantidade</th><th></th></tr></thead><tbody id="stock-tbody"></tbody></table></div>';
  return html;
};
ROUTES.estoque__after = function(){
  function renderRows(filter){
    var f=(filter||'').toLowerCase();
    var rows = STATE.stock.filter(function(s){ var lbl=productLabel(s.productId,s.variationId).toLowerCase(); return !f || lbl.indexOf(f)>=0; });
    var tbody = document.getElementById('stock-tbody');
    if(rows.length===0){ tbody.innerHTML='<tr><td colspan="4" class="empty-state">Nada encontrado.</td></tr>'; return; }
    tbody.innerHTML = rows.map(function(s){
      return '<tr><td>'+esc(productLabel(s.productId,s.variationId))+'</td><td>'+esc(locationLabel(s.locationId))+'</td><td class="qty">'+s.quantity+'</td><td class="right"><button class="btn btn-sm" data-adjust="'+s.id+'">Ajustar</button></td></tr>';
    }).join('');
    tbody.querySelectorAll('[data-adjust]').forEach(function(b){ b.addEventListener('click', function(){ openAdjustStock(b.getAttribute('data-adjust')); }); });
  }
  renderRows('');
  document.getElementById('f-search-stock').addEventListener('input', function(e){ renderRows(e.target.value); });
};
function openAdjustStock(stockId){
  var s = byId(STATE.stock, stockId);
  if(!s) return;
  var html = '<div class="modal-head"><h3>Ajustar estoque</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<p>'+esc(productLabel(s.productId,s.variationId))+' em '+esc(locationLabel(s.locationId))+'</p>';
  html += '<div class="field"><label>Nova quantidade</label><input type="number" min="0" id="f-adjust-qty" value="'+s.quantity+'"></div>';
  html += '<div class="field"><label>Motivo do ajuste</label><input type="text" id="f-adjust-note" placeholder="ex: contagem de inventário"></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="btn-save-adjust">Salvar ajuste</button></div>';
  openModal(html);
  document.getElementById('btn-save-adjust').addEventListener('click', function(){
    var newQty = Number(document.getElementById('f-adjust-qty').value);
    var note = document.getElementById('f-adjust-note').value.trim();
    var delta = newQty - s.quantity;
    if(delta!==0){
      adjustStock(s.productId, s.variationId, s.locationId, delta);
      addMovement('ajuste', s.productId, s.variationId, delta, s.locationId, 'ajuste', null, note);
      addAudit('Ajustou estoque','estoque',s.productId, (delta>0?'+':'')+delta+' em '+locationLabel(s.locationId)+(note?' — '+note:''));
    }
    closeModal(); toast('Estoque ajustado.','good'); saveState();
  });
}

ROUTES.movimentacoes = function(){
  if(STATE.stockMovements.length===0) return emptyState('Nenhuma movimentação registrada.');
  var html = '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Tipo</th><th>Produto</th><th>Qtd.</th><th>Local</th><th>Usuário</th><th>Nota</th></tr></thead><tbody>';
  STATE.stockMovements.slice(0,300).forEach(function(m){
    html += '<tr><td>'+fmtDate(m.timestamp)+'</td><td>'+statusMovBadge(m.type)+'</td><td>'+esc(productLabel(m.productId,m.variationId))+'</td><td class="qty">'+m.quantity+'</td><td>'+esc(locationLabel(m.locationId))+'</td><td>'+esc(m.userName)+'</td><td class="small muted">'+esc(m.note||'')+'</td></tr>';
  });
  html += '</tbody></table></div>';
  return html;
};
function statusMovBadge(t){
  var map = { entrada:'good', saida:'bad', ajuste:'warn', transferencia:'info' };
  return '<span class="badge badge-'+(map[t]||'info')+'">'+esc(movTypeLabel(t))+'</span>';
}

/* ============ CONSULTA DE ESTOQUE ============
   Tela dedicada (grupo "Estoque") para consultar rapidamente a situação de
   qualquer produto cadastrado: busca por SKU, e ao clicar num resultado
   mostra o total em estoque somando todas as variações, a quantidade de
   cada variação separadamente e as últimas movimentações desse produto —
   pedido explícito da usuária. Reaproveita os mesmos helpers de estoque
   (totalStockForProduct, variationName, stockMovements) já usados na tela
   de detalhe de Produtos, só que com foco só na consulta (sem edição). */
ROUTES['consulta-estoque'] = function(args){
  if(args && args[0]) return stockQueryDetailHtml(args[0]);
  var html = '<p class="muted small mb0">Busque um produto pelo SKU e clique nele para ver o total em estoque, a quantidade de cada variação e as últimas movimentações.</p>';
  html += '<div class="toolbar mt14"><div class="toolbar-left"><input type="search" id="f-search-stock-query" placeholder="Buscar por SKU…" style="width:280px"></div></div>';
  if(STATE.products.length===0){
    html += emptyState('Nenhum produto cadastrado ainda.');
  } else {
    html += '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Produto</th><th>Categoria</th><th>Estoque total</th><th></th></tr></thead><tbody id="stock-query-tbody"></tbody></table></div>';
  }
  return html;
};
function renderStockQueryRows(filter){
  var tbody = document.getElementById('stock-query-tbody');
  if(!tbody) return;
  var f = (filter||'').toLowerCase().trim();
  var rows = STATE.products.filter(function(p){ return !f || p.sku.toLowerCase().indexOf(f)>=0; });
  if(rows.length===0){ tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum produto encontrado com esse SKU.</td></tr>'; return; }
  tbody.innerHTML = rows.map(function(p){
    var cat = findCategory(p.categoryId);
    var total = totalStockForProduct(p.id);
    return '<tr><td class="code-cell">'+esc(p.sku)+'</td><td><a href="#/consulta-estoque/'+p.id+'">'+esc(p.name)+'</a></td><td>'+(cat?esc(cat.name):'—')+'</td><td class="qty">'+total+(total===0?' <span class="badge badge-warn">sem estoque</span>':'')+'</td><td class="right"><a class="btn btn-sm" href="#/consulta-estoque/'+p.id+'">Ver</a></td></tr>';
  }).join('');
}
ROUTES['consulta-estoque__after'] = function(args){
  if(args && args[0]) return;
  renderStockQueryRows('');
  var search = document.getElementById('f-search-stock-query');
  if(search) search.addEventListener('input', function(){ renderStockQueryRows(search.value); });
};
function stockQueryDetailHtml(id){
  var p = findProduct(id);
  if(!p) return emptyState('Produto não encontrado.');
  var cat = findCategory(p.categoryId);
  var movs = STATE.stockMovements.filter(function(m){return m.productId===id;}).slice(0,20);
  var totalGeral = totalStockForProduct(id);
  var html = '<div class="toolbar"><a href="#/consulta-estoque" class="small">← Voltar para consulta de estoque</a></div>';
  html += '<div class="detail-grid">';
  html += '<div class="card"><h3>'+esc(p.name)+'</h3><div class="muted small mt8">SKU '+esc(p.sku)+(cat?' · '+esc(cat.name):'')+(p.brand? ' · '+esc(p.brand):'')+'</div>';
  html += '<div class="stat-line mt14"><span class="k">Estoque total (todas as variações)</span><span class="qty">'+totalGeral+'</span></div>';
  if(p.variations && p.variations.length){
    html += '<h4 class="mt14">Quantidade por variação</h4>';
    html += '<div class="table-wrap"><table><thead><tr><th>Variação</th><th>Quantidade</th></tr></thead><tbody>';
    p.variations.forEach(function(v){ html += '<tr><td>'+esc(v.name)+'</td><td class="qty">'+totalStockForProduct(id, v.id)+'</td></tr>'; });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="small muted mt8">Este produto não tem variações cadastradas — o total acima já é o estoque completo dele.</p>';
  }
  html += '</div>';
  html += '<div class="card"><h4>Últimas movimentações</h4>';
  if(movs.length===0) html += emptyState('Sem movimentações registradas para este produto.');
  else {
    html += '<ul class="timeline">';
    movs.forEach(function(m){
      var vn = variationName(p, m.variationId);
      html += '<li><span class="t">'+fmtDate(m.timestamp)+' · '+esc(m.userName)+'</span>'+esc(movTypeLabel(m.type))+' de '+m.quantity+' un.'+(vn?' — '+esc(vn):'')+' em '+esc(locationLabel(m.locationId))+(m.note?' — '+esc(m.note):'')+'</li>';
    });
    html += '</ul>';
  }
  html += '</div>';
  html += '</div>';
  return html;
}

/* ============ VENDAS ============ */
ROUTES.vendas = function(args){
  if(args && args[0]) return salesOrderDetailHtml(args[0]);
  var html = '<div class="toolbar"><div></div><div class="toolbar-left">';
  html += '<button class="btn btn-primary" id="btn-add-so-loja">+ Venda na loja</button>';
  html += '<button class="btn" id="btn-add-so-online">+ Pedido online</button>';
  html += '</div></div>';
  if(STATE.salesOrders.length===0) html += emptyState('Nenhum pedido de venda registrado.');
  else {
    html += '<div class="table-wrap"><table><thead><tr><th>Código</th><th>Canal</th><th>Cliente</th><th>Prioridade</th><th>Status</th><th></th></tr></thead><tbody>';
    STATE.salesOrders.slice().reverse().forEach(function(o){
      var cus = findCustomer(o.customerId);
      html += '<tr><td class="code-cell">'+esc(o.code)+'</td><td>'+(o.channel==='LOJA'?'Loja física':'Online')+'</td><td>'+(cus?esc(cus.name):'Consumidor')+'</td><td class="'+(o.priority==='ALTA'?'priority-alta':'')+'">'+(o.priority==='ALTA'?'Alta':'Normal')+'</td><td>'+statusBadge(o.status)+'</td><td class="right"><a class="btn btn-sm" href="#/vendas/'+o.id+'">Ver</a></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  return html;
};
var TEMP_SO_ITEMS = [];
function openSalesOrderForm(channel){
  TEMP_SO_ITEMS = [];
  renderSOModal(channel);
}
function renderSOModal(channel){
  var html = '<div class="modal-head"><h3>'+(channel==='LOJA'?'Nova venda na loja':'Novo pedido online')+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field"><label>Cliente (opcional)</label><div class="flex gap8"><select id="f-so-customer" style="flex:1"><option value="">Consumidor não identificado</option>'+selectOptions(STATE.customers,'id',function(c){return c.name;})+'</select><button class="btn btn-sm" type="button" id="btn-quick-cus">+ Novo</button></div></div>';
  html += '<h4>Itens</h4><div id="so-items"></div>';
  html += '<button class="btn btn-sm" type="button" id="btn-so-add-item">+ Adicionar item</button>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-so">Criar pedido</button></div>';
  openModal(html, {wide:true});
  document.getElementById('btn-quick-cus').addEventListener('click', function(){ openPartyForm('customers', null, function(c){ renderSOModal(channel); setTimeout(function(){ document.getElementById('f-so-customer').value=c.id; },0); }); });
  document.getElementById('btn-so-add-item').addEventListener('click', function(){ TEMP_SO_ITEMS.push({key:Math.random().toString(36).slice(2,8), productId:'', variationId:'', qty:1}); renderSoItemRows(); });
  document.getElementById('save-so').addEventListener('click', function(){ submitSalesOrder(channel); });
  renderSoItemRows();
}
function renderSoItemRows(){
  var wrap = document.getElementById('so-items');
  if(!wrap) return;
  if(TEMP_SO_ITEMS.length===0){ wrap.innerHTML='<div class="small muted mt8">Nenhum item adicionado.</div>'; return; }
  wrap.innerHTML = TEMP_SO_ITEMS.map(function(it, idx){
    var p = findProduct(it.productId);
    var avail = p ? totalStockForProduct(p.id, it.variationId||undefined) : null;
    var row = '<div class="card" style="padding:12px;margin-bottom:8px;">';
    row += '<div class="flex gap8 items-center"><label class="mb0" style="flex:1">Item '+(idx+1)+'</label><button type="button" class="btn btn-sm btn-ghost" data-rm-item="'+idx+'">Remover</button></div>';
    row += '<div class="field-row mt8"><div class="field"><label>Produto</label><select data-f="productId" data-idx="'+idx+'"><option value="">Selecione…</option>'+selectOptions(STATE.products,'id',function(pp){return pp.sku+' — '+pp.name;}, it.productId)+'</select></div>';
    if(p && p.variations && p.variations.length){
      row += '<div class="field"><label>Variação</label><select data-f="variationId" data-idx="'+idx+'"><option value="">—</option>'+selectOptions(p.variations,'id',function(v){return v.name;}, it.variationId)+'</select></div>';
    }
    row += '</div>';
    row += '<div class="field"><label>Quantidade'+(p?' (disponível: '+avail+')':'')+'</label><input type="number" min="1" value="'+it.qty+'" data-f="qty" data-idx="'+idx+'"></div>';
    if(p && avail!==null && avail < it.qty) row += '<div class="badge badge-warn">Estoque insuficiente</div>';
    row += '</div>';
    return row;
  }).join('');
  wrap.querySelectorAll('[data-rm-item]').forEach(function(b){ b.addEventListener('click', function(){ TEMP_SO_ITEMS.splice(Number(b.getAttribute('data-rm-item')),1); renderSoItemRows(); }); });
  wrap.querySelectorAll('[data-f]').forEach(function(el){
    el.addEventListener('change', function(){
      var idx=Number(el.getAttribute('data-idx')); var f=el.getAttribute('data-f');
      TEMP_SO_ITEMS[idx][f] = (f==='qty')? Number(el.value): el.value;
      if(f==='productId') renderSoItemRows();
    });
  });
}
function submitSalesOrder(channel){
  if(TEMP_SO_ITEMS.length===0){ toast('Adicione ao menos um item.','bad'); return; }
  for(var i=0;i<TEMP_SO_ITEMS.length;i++){
    if(!TEMP_SO_ITEMS[i].productId){ toast('Selecione o produto do item '+(i+1)+'.','bad'); return; }
    if(!TEMP_SO_ITEMS[i].qty || TEMP_SO_ITEMS[i].qty<=0){ toast('Informe a quantidade do item '+(i+1)+'.','bad'); return; }
  }
  var id = uid('so');
  var code = 'PED-'+pad4(STATE.meta.seq.so-1);
  var items = TEMP_SO_ITEMS.map(function(it){ return { id:uid('soi'), productId:it.productId, variationId:it.variationId||null, qty:it.qty, locationId:null, separated:false, conferred:false }; });
  var customerId = document.getElementById('f-so-customer') ? document.getElementById('f-so-customer').value || null : null;
  STATE.salesOrders.push({ id:id, code:code, channel:channel, customerId:customerId, items:items, status:'AGUARDANDO_SEPARACAO', priority: channel==='LOJA'?'ALTA':'NORMAL', createdAt:Date.now(), createdBy: currentUser()?currentUser().id:null });
  addAudit('Criou pedido de venda','pedido_venda',id,code);
  closeModal(); toast('Pedido criado.','good'); saveState();
  setRoute('/vendas/'+id);
}

function salesOrderDetailHtml(id){
  var o = findSO(id);
  if(!o) return emptyState('Pedido não encontrado.');
  var cus = findCustomer(o.customerId);
  var html = '<div class="toolbar"><a href="#/vendas" class="small">← Voltar</a></div>';
  html += '<div class="card"><div class="flex" style="justify-content:space-between"><div><h3>'+esc(o.code)+'</h3><div class="muted small">'+(o.channel==='LOJA'?'Loja física':'Online')+' · Cliente: '+(cus?esc(cus.name):'Consumidor não identificado')+' · Prioridade: <span class="'+(o.priority==='ALTA'?'priority-alta':'')+'">'+(o.priority==='ALTA'?'Alta':'Normal')+'</span></div></div>'+statusBadge(o.status)+'</div>';
  html += '<div class="table-wrap mt14"><table><thead><tr><th>Produto</th><th>Qtd.</th><th>Local</th><th>Separado</th><th>Conferido</th></tr></thead><tbody>';
  var total = 0;
  o.items.forEach(function(it){
    var p = findProduct(it.productId);
    if(p && p.price) total += p.price*it.qty;
    html += '<tr><td>'+esc(productLabel(it.productId,it.variationId))+'</td><td class="qty">'+it.qty+'</td><td>'+(it.locationId?esc(locationLabel(it.locationId)):'—')+'</td><td>'+(it.separated?'✓':'—')+'</td><td>'+(it.conferred?'✓':'—')+'</td></tr>';
  });
  html += '</tbody></table></div>';
  if(total>0) html += '<div class="mt14 right"><strong>Total: '+money(total)+'</strong></div>';
  if(o.status==='AGUARDANDO_SEPARACAO' || o.status==='EM_SEPARACAO') html += '<div class="readonly-banner mt14">Pedido aguardando separação (separação é feita no sistema coletor).</div>';
  if(o.status==='EM_CONFERENCIA') html += '<div class="readonly-banner mt14">Pedido em conferência (conferência é feita no sistema coletor).</div>';
  if(o.status==='AGUARDANDO_PAGAMENTO') html += '<div class="mt14"><a class="btn btn-primary" href="#/pagamento">Ir para pagamento →</a></div>';
  if(o.status==='AGUARDANDO_EXPEDICAO') html += '<div class="mt14"><a class="btn btn-primary" href="#/expedicao">Ir para expedição →</a></div>';
  var shipment = STATE.shipments.find(function(s){return s.salesOrderId===o.id;});
  if(shipment){
    html += '<h4 class="mt14">Rastreamento</h4><div class="card">';
    html += '<div class="stat-line"><span class="k">Transportadora</span><span>'+esc(shipment.carrier)+'</span></div>';
    html += '<div class="stat-line"><span class="k">Código de rastreio</span><span class="mono">'+esc(shipment.trackingCode)+'</span></div>';
    html += '<ul class="timeline mt8">';
    shipment.events.forEach(function(ev){ html += '<li><span class="t">'+fmtDate(ev.timestamp)+'</span>'+esc(ev.status)+(ev.note?' — '+esc(ev.note):'')+'</li>'; });
    html += '</ul>';
    if(o.status==='ENVIADO'){
      html += '<div class="flex gap8 mt8"><input type="text" id="f-ship-event" placeholder="Novo status (ex: Em rota de entrega)" style="flex:1"><button class="btn btn-sm" id="btn-add-ship-event">Adicionar</button><button class="btn btn-sm btn-primary" id="btn-mark-delivered">Marcar entregue</button></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}
ROUTES.vendas__after = function(args){
  if(args && args[0]){
    var o = findSO(args[0]);
    var addEv = document.getElementById('btn-add-ship-event');
    if(addEv) addEv.addEventListener('click', function(){
      var val = document.getElementById('f-ship-event').value.trim();
      if(!val) return;
      var shipment = STATE.shipments.find(function(s){return s.salesOrderId===o.id;});
      shipment.events.push({status:val, timestamp:Date.now()});
      addAudit('Atualizou rastreio','pedido_venda',o.id,val);
      toast('Evento adicionado.','good'); saveState();
    });
    var deliv = document.getElementById('btn-mark-delivered');
    if(deliv) deliv.addEventListener('click', function(){
      var shipment = STATE.shipments.find(function(s){return s.salesOrderId===o.id;});
      shipment.events.push({status:'Entregue', timestamp:Date.now()});
      o.status='CONCLUIDO';
      addAudit('Marcou como entregue','pedido_venda',o.id,o.code);
      toast('Pedido concluído.','good'); saveState();
    });
    return;
  }
  var b1 = document.getElementById('btn-add-so-loja'); if(b1) b1.addEventListener('click', function(){ openSalesOrderForm('LOJA'); });
  var b2 = document.getElementById('btn-add-so-online'); if(b2) b2.addEventListener('click', function(){ openSalesOrderForm('ONLINE'); });
};

/* ============ PAGAMENTO (loja física) ============ */
ROUTES.pagamento = function(){
  var q = STATE.salesOrders.filter(function(o){ return o.status==='AGUARDANDO_PAGAMENTO'; });
  if(q.length===0) return emptyState('Nenhum pedido aguardando pagamento.');
  var html = '<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th></th></tr></thead><tbody>';
  q.forEach(function(o){
    var cus = findCustomer(o.customerId);
    var total = 0; o.items.forEach(function(it){ var p=findProduct(it.productId); if(p&&p.price) total+=p.price*it.qty; });
    html += '<tr><td class="code-cell">'+esc(o.code)+'</td><td>'+(cus?esc(cus.name):'Consumidor')+'</td><td>'+(total>0?money(total):'—')+'</td><td class="right"><button class="btn btn-sm btn-primary" data-pay="'+o.id+'">Receber pagamento</button></td></tr>';
  });
  html += '</tbody></table></div>';
  return html;
};
ROUTES.pagamento__after = function(){ document.querySelectorAll('[data-pay]').forEach(function(b){ b.addEventListener('click', function(){ openPaymentFlow(b.getAttribute('data-pay')); }); }); };
function openPaymentFlow(orderId){
  var o = findSO(orderId);
  if(!o) return;
  var total = 0; o.items.forEach(function(it){ var p=findProduct(it.productId); if(p&&p.price) total+=p.price*it.qty; });
  var html = '<div class="modal-head"><h3>Pagamento — '+esc(o.code)+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qtd.</th></tr></thead><tbody>';
  o.items.forEach(function(it){ html += '<tr><td>'+esc(productLabel(it.productId,it.variationId))+'</td><td class="qty">'+it.qty+'</td></tr>'; });
  html += '</tbody></table></div>';
  html += '<div class="field-row mt14"><div class="field"><label>Método</label><select id="f-pay-method"><option value="Dinheiro">Dinheiro</option><option value="Cartão">Cartão</option><option value="Pix">Pix</option></select></div>';
  html += '<div class="field"><label>Valor recebido (R$)</label><input type="number" step="0.01" min="0" id="f-pay-amount" value="'+(total>0?total.toFixed(2):'')+'"></div></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="btn-confirm-pay">Confirmar pagamento</button></div>';
  openModal(html, {wide:true});
  document.getElementById('btn-confirm-pay').addEventListener('click', function(){
    var method = document.getElementById('f-pay-method').value;
    var amount = Number(document.getElementById('f-pay-amount').value)||0;
    var u = currentUser();
    STATE.payments.push({ id:uid('pay'), salesOrderId:o.id, amount:amount, method:method, receivedBy:u?u.id:null, timestamp:Date.now() });
    o.status = 'CONCLUIDO';
    addAudit('Recebeu pagamento','pedido_venda',o.id, method+' — '+money(amount));
    closeModal(); toast('Pagamento confirmado. Pedido concluído.','good'); saveState();
  });
}

/* ============ EXPEDIÇÃO (vendas online) ============ */
ROUTES.expedicao = function(){
  var q = STATE.salesOrders.filter(function(o){ return o.status==='AGUARDANDO_EXPEDICAO'; });
  if(q.length===0) return emptyState('Nenhum pedido aguardando expedição.');
  var html = '<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Itens</th><th></th></tr></thead><tbody>';
  q.forEach(function(o){
    var cus = findCustomer(o.customerId);
    html += '<tr><td class="code-cell">'+esc(o.code)+'</td><td>'+(cus?esc(cus.name):'—')+'</td><td>'+o.items.length+'</td><td class="right"><button class="btn btn-sm btn-primary" data-ship="'+o.id+'">Expedir</button></td></tr>';
  });
  html += '</tbody></table></div>';
  return html;
};
ROUTES.expedicao__after = function(){ document.querySelectorAll('[data-ship]').forEach(function(b){ b.addEventListener('click', function(){ openShipFlow(b.getAttribute('data-ship')); }); }); };
function openShipFlow(orderId){
  var o = findSO(orderId);
  if(!o) return;
  var html = '<div class="modal-head"><h3>Expedição — '+esc(o.code)+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field"><label>Transportadora</label><input type="text" id="f-ship-carrier" placeholder="ex: Correios, Jadlog…"></div>';
  html += '<div class="field"><label>Código de rastreio</label><input type="text" id="f-ship-code" placeholder="ex: BR123456789"></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="btn-confirm-ship">Confirmar postagem</button></div>';
  openModal(html);
  document.getElementById('btn-confirm-ship').addEventListener('click', function(){
    var carrier = document.getElementById('f-ship-carrier').value.trim();
    var code = document.getElementById('f-ship-code').value.trim();
    if(!carrier || !code){ toast('Preencha transportadora e código de rastreio.','bad'); return; }
    var u = currentUser();
    STATE.shipments.push({ id:uid('ship'), salesOrderId:o.id, carrier:carrier, trackingCode:code, postedBy:u?u.id:null, timestamp:Date.now(), events:[{status:'Postado', timestamp:Date.now()}] });
    o.status = 'ENVIADO';
    addAudit('Expediu pedido','pedido_venda',o.id, carrier+' — '+code);
    closeModal(); toast('Pedido expedido.','good'); saveState();
  });
}

/* ============ USUÁRIOS ============ */
var ALL_ROLES = ['ADMIN','OPERADOR_CADASTROS','COMPRADOR','OPERADOR_ESTOQUE','VENDEDOR','CONFERENTE'];
function defaultPermissionsForRole(role){
  var paths = [];
  NAV_GROUPS.forEach(function(g){ g.items.forEach(function(it){
    if(it.roles && it.roles.indexOf(role) >= 0) paths.push(it.path);
  }); });
  return paths;
}
/* Checklist de telas do formulário de usuário — pedido explícito da usuária:
   além da função (nomenclatura) do operador, o administrador pode marcar ou
   desmarcar individualmente cada tela que aquele operador específico poderá
   acessar — um acesso totalmente personalizado por usuário. Ao trocar a
   função no formulário, a checklist é reconstruída com os padrões da nova
   função (ver openUserForm) e o administrador ajusta o que quiser a partir
   daí. "Usuários" e "Histórico" ficam com um aviso, por serem telas
   administrativas — dar acesso a elas para quem não é Administrador é uma
   decisão consciente (permite editar outros usuários e ver a auditoria). */
function permChecklistHtml(role, checkedList){
  var html = '';
  NAV_GROUPS.forEach(function(g){
    var items = g.items.filter(function(it){ return it.roles; });
    if(!items.length) return;
    html += '<div class="perm-group" style="margin-bottom:10px;"><div class="nav-group-label" style="padding:4px 0 2px;">'+esc(g.label)+'</div>';
    items.forEach(function(it){
      var isChecked = checkedList ? (checkedList.indexOf(it.path)>=0) : (it.roles.indexOf(role)>=0);
      var sensitive = (it.path==='usuarios' || it.path==='historico');
      html += '<label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:0 0 4px;font-size:13px;"><input type="checkbox" class="perm-check" value="'+it.path+'"'+(isChecked?' checked':'')+'> '+esc(it.label)+(sensitive?' <span class="badge badge-warn">acesso administrativo</span>':'')+'</label>';
    });
    html += '</div>';
  });
  return html;
}
ROUTES.usuarios = function(){
  var html = '<div class="toolbar"><div></div><button class="btn btn-primary" id="btn-add-user">+ Novo usuário</button></div>';
  html += '<div class="table-wrap"><table><thead><tr><th>Nome</th><th>Usuário</th><th>Função</th><th>Status</th><th></th></tr></thead><tbody>';
  STATE.users.forEach(function(u){
    html += '<tr><td>'+esc(u.name)+'</td><td class="code-cell">'+esc(u.username||'—')+'</td><td>'+esc(roleLabel(u.role))+'</td><td>'+(u.active?'<span class="badge badge-good">Ativo</span>':'<span class="badge badge-info">Inativo</span>')+'</td>';
    html += '<td class="right"><button class="btn btn-sm" data-edit-user="'+u.id+'">Editar</button> <button class="btn btn-sm" data-toggle-user="'+u.id+'">'+(u.active?'Desativar':'Ativar')+'</button></td></tr>';
  });
  html += '</tbody></table></div>';
  html += '<p class="small muted mt14">Cada usuário entra com seu próprio usuário e senha. Esta é uma proteção do nível da aplicação: como o sistema roda inteiramente no navegador (sem servidor), qualquer pessoa com acesso técnico ao link pode inspecionar o código. Ainda assim, a senha nunca fica salva em texto puro — apenas seu hash.</p>';
  return html;
};
ROUTES.usuarios__after = function(){
  document.getElementById('btn-add-user').addEventListener('click', function(){ openUserForm(null); });
  document.querySelectorAll('[data-edit-user]').forEach(function(b){ b.addEventListener('click', function(){ openUserForm(findUser(b.getAttribute('data-edit-user'))); }); });
  document.querySelectorAll('[data-toggle-user]').forEach(function(b){ b.addEventListener('click', function(){
    var u = findUser(b.getAttribute('data-toggle-user')); u.active = !u.active;
    addAudit(u.active?'Ativou usuário':'Desativou usuário','usuario',u.id,u.name);
    toast('Atualizado.','good'); saveState();
  }); });
};

function openUserForm(user){
  var initialRole = user ? user.role : 'OPERADOR_ESTOQUE';
  var html = '<div class="modal-head"><h3>'+(user?'Editar usuário':'Novo usuário')+'</h3><button class="modal-close" onclick="closeModal()">×</button></div>';
  html += '<div class="field"><label>Nome</label><input type="text" id="f-user-name" value="'+(user?esc(user.name):'')+'"></div>';
  html += '<div class="field"><label>Usuário (login)</label><input type="text" id="f-user-username" autocapitalize="off" autocorrect="off" value="'+(user?esc(user.username||''):'')+'"></div>';
  html += '<div class="field"><label>Função</label><select id="f-user-role">'+ALL_ROLES.map(function(r){ return '<option value="'+r+'"'+(user&&user.role===r?' selected':'')+'>'+roleLabel(r)+'</option>'; }).join('')+'</select></div>';
  html += '<div class="field" id="perm-field"><label>Permissões de telas (acesso personalizado)</label>';
  html += '<p class="small muted" style="margin-top:-2px">A função acima já marca as telas padrão dela — marque ou desmarque qualquer tela para personalizar o acesso só deste operador. Telas com <span class="badge badge-warn">acesso administrativo</span> permitem gerenciar outros usuários mesmo sem a função Administrador.</p>';
  html += '<div id="perm-checklist">'+permChecklistHtml(initialRole, user && user.customPermissions ? user.customPermissions : null)+'</div></div>';
  html += '<div class="field"><label>Senha'+(user?' (deixe em branco para manter a atual)':'')+'</label><input type="password" id="f-user-pass" autocomplete="new-password"></div>';
  html += '<div class="field"><label>Confirmar senha</label><input type="password" id="f-user-pass2" autocomplete="new-password"></div>';
  html += '<div id="user-form-error" class="login-error" style="display:none"></div>';
  html += '<div class="modal-foot"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" id="save-user">Salvar</button></div>';
  openModal(html, {wide:true});
  function updatePermVisibility(){
    var role = document.getElementById('f-user-role').value;
    var field = document.getElementById('perm-field');
    field.style.display = (role==='ADMIN') ? 'none' : '';
  }
  updatePermVisibility();
  document.getElementById('f-user-role').addEventListener('change', function(){
    document.getElementById('perm-checklist').innerHTML = permChecklistHtml(this.value, null);
    updatePermVisibility();
  });
  function showErr(msg){ var el=document.getElementById('user-form-error'); el.textContent=msg; el.style.display='block'; }
  document.getElementById('save-user').addEventListener('click', async function(){
    var name = document.getElementById('f-user-name').value.trim();
    var username = document.getElementById('f-user-username').value.trim().toLowerCase();
    var role = document.getElementById('f-user-role').value;
    var pass = document.getElementById('f-user-pass').value;
    var pass2 = document.getElementById('f-user-pass2').value;
    document.getElementById('user-form-error').style.display='none';
    if(!name){ showErr('Informe o nome.'); return; }
    if(!username){ showErr('Informe o usuário (login).'); return; }
    var dup = STATE.users.find(function(u){ return u.username && u.username.toLowerCase()===username && (!user || u.id!==user.id); });
    if(dup){ showErr('Já existe um usuário com esse login.'); return; }
    if(!user && !pass){ showErr('Informe uma senha.'); return; }
    if(pass && pass!==pass2){ showErr('As senhas não coincidem.'); return; }
    var customPermissions = null;
    if(role !== 'ADMIN'){
      customPermissions = [];
      document.querySelectorAll('#perm-checklist .perm-check').forEach(function(cb){ if(cb.checked) customPermissions.push(cb.value); });
    }
    var btn = document.getElementById('save-user');
    btn.disabled = true;
    try{
      if(!user){
        var created = await callManageUser({ action:'create', name:name, login:username, role:role, customPermissions:customPermissions, password:pass });
        STATE.users.push({ id:created.id, name:name, username:username, role:role, active:true, customPermissions:customPermissions });
        addAudit('Cadastrou usuário','usuario',created.id,name);
        closeModal(); toast('Usuário criado.','good'); saveState();
      } else {
        await callManageUser({ action:'update', legacyId:user.id, name:name, login:username, role:role, customPermissions:customPermissions, password: pass||undefined });
        user.name=name; user.username=username; user.role=role; user.customPermissions=customPermissions;
        addAudit('Editou usuário','usuario',user.id,name);
        closeModal(); toast('Salvo.','good'); saveState();
      }
    }catch(err){
      btn.disabled = false;
      showErr(err.message || 'Erro ao salvar usuário.');
    }
  });
}

/* ============ HISTÓRICO / AUDITORIA ============ */
ROUTES.historico = function(){
  if(STATE.auditLog.length===0) return emptyState('Nenhuma atividade registrada ainda.');
  var html = '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>';
  STATE.auditLog.slice(0,500).forEach(function(a){
    html += '<tr><td>'+fmtDate(a.timestamp)+'</td><td>'+esc(a.userName)+'</td><td>'+esc(a.action)+'</td><td class="small muted">'+esc(a.details||'')+'</td></tr>';
  });
  html += '</tbody></table></div>';
  return html;
};

/* ============ INICIALIZACAO ============ */
async function boot(){
  supabaseClient.auth.onAuthStateChange(function(event, session){ CURRENT_AUTH = session; });
  try{
    var existingRes = await supabaseClient.auth.getSession();
    var existing = existingRes.data && existingRes.data.session;
    if(existing){
      CURRENT_AUTH = existing;
      await loadAllData();
      var email = existing.user && existing.user.email;
      var loginFromEmail = email ? email.split('@')[0] : null;
      var me = STATE.users.find(function(u){ return u.username === loginFromEmail; });
      if(me && me.active){ SESSION = { userId: me.id }; }
    }
  }catch(e){ console.error('Falha ao restaurar sessão:', e); }
  render();
}
document.addEventListener('DOMContentLoaded', boot);

})();
