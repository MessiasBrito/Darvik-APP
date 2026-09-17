-- ============================================================================
-- DARVIK — Schema do banco de dados (Supabase / Postgres)
-- ============================================================================
-- Este arquivo cria toda a estrutura de dados do sistema, migrando o antigo
-- STATE (um único JSON embutido no Artifact) para tabelas reais no Postgres.
--
-- Como rodar: abra o painel do seu projeto Supabase → SQL Editor → cole todo
-- este arquivo → Run. É seguro rodar mais de uma vez (usa "if not exists"/
-- "or replace" onde possível), mas o ideal é rodar uma vez só, num projeto
-- novo, antes do seed.sql.
--
-- Decisões importantes (documentadas aqui para quem for mexer depois):
--
-- 1) IDs continuam sendo texto legível (ex.: "prod-3", "po-7"), exatamente
--    como no sistema antigo — não trocamos para UUID. Isso evita qualquer
--    remapeamento de referências entre tabelas e mantém os mesmos IDs que já
--    existem nos dados reais.
--
-- 2) Estruturas aninhadas do STATE antigo (variações de produto, itens de
--    pedido de compra/venda) viram colunas JSONB — não foram normalizadas em
--    tabelas filhas. Isso mantém o formato dos dados praticamente idêntico ao
--    que o front-end já manipula em memória, reduzindo o risco de reescrever
--    a lógica de negócio inteira.
--
-- 3) Segurança (Row Level Security): LEITURA é liberada para qualquer usuário
--    AUTENTICADO em quase todas as tabelas — isso reproduz o comportamento do
--    sistema antigo, que já carregava o STATE inteiro no navegador de
--    qualquer pessoa logada (o controle de acesso por papel sempre foi só
--    uma questão de esconder/mostrar telas, nunca de esconder dados). A
--    ESCRITA (inserir/alterar/apagar), por outro lado, agora é validada de
--    verdade no banco, por tela, usando a mesma lógica de permissões
--    personalizadas por operador (Versão 17) — isso é uma melhoria real de
--    segurança em relação ao sistema antigo, que não tinha nenhuma validação
--    no lado do servidor (não existia servidor).
--
-- 4) Senhas NÃO são mais geridas por este sistema (nada de hash/sal
--    guardado em tabela) — usamos o Supabase Auth de verdade, que guarda
--    senhas com um algoritmo de hash forte (bcrypt) dentro do próprio
--    Supabase. Cada usuário do sistema é um usuário do Supabase Auth com um
--    e-mail "sintético" (login+"@darvik.local"), e a tabela "profiles" só
--    guarda nome/login/função/permissões — nunca a senha.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) Extensões necessárias
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Tabela de perfis (substitui a parte de "papel/nome/permissões" do antigo
--    STATE.users — a senha em si fica só no Supabase Auth, nunca aqui).
-- ---------------------------------------------------------------------------
-- "legacy_id" é o mesmo id curto e legível que o sistema antigo já usava
-- (ex.: "u1", "user-2") — guardamos ele à parte da chave primária real
-- porque a chave primária de "profiles" PRECISA ser o uuid que o Supabase
-- Auth gera para a conta (é assim que login/senha funcionam). Todo o resto
-- do sistema (movimentações, auditoria, pedidos) continua referenciando
-- usuários pelo legacy_id, exatamente como sempre fez — isso evita ter que
-- remapear nenhum dado existente.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  legacy_id text not null unique,
  name text not null,
  login text not null unique,
  role text not null check (role in ('ADMIN','OPERADOR_CADASTROS','COMPRADOR','OPERADOR_ESTOQUE','VENDEDOR','CONFERENTE')),
  custom_permissions text[],
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- View pública mínima usada SÓ para a tela de login traduzir "usuário digitado"
-- em e-mail interno do Supabase Auth — nunca expõe senha nem nenhum outro
-- dado. É por isso que pode ficar de leitura livre (sem exigir login), já que
-- login não é informação sigilosa (o próprio formulário de login já pede
-- para digitá-lo).
create or replace view login_lookup as
  select login, (login || '@darvik.local') as email
  from profiles
  where active = true;

-- ---------------------------------------------------------------------------
-- 2) Tabelas de cadastro
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id text primary key,
  name text not null
);

create table if not exists suppliers (
  id text primary key,
  name text not null,
  contact text,
  phone text
);

create table if not exists customers (
  id text primary key,
  name text not null,
  contact text,
  phone text
);

create table if not exists products (
  id text primary key,
  sku text unique not null,
  name text not null,
  category_id text references categories(id) on delete set null,
  brand text,
  price numeric(12,2),
  variations jsonb not null default '[]'::jsonb, -- [{id,name}]
  created_at timestamptz not null default now()
);

create table if not exists locations (
  id text primary key,
  corridor text,
  shelf text,
  level text,
  capacity int,
  code text unique,
  qr_payload text
);

-- ---------------------------------------------------------------------------
-- 3) Estoque
-- ---------------------------------------------------------------------------
create table if not exists stock (
  id text primary key,
  product_id text references products(id) on delete cascade,
  variation_id text,
  location_id text references locations(id) on delete set null,
  quantity numeric not null default 0
);

create table if not exists stock_movements (
  id text primary key,
  type text not null, -- entrada | saida | ajuste | transferencia
  product_id text references products(id) on delete set null,
  variation_id text,
  quantity numeric not null,
  location_id text references locations(id) on delete set null,
  user_id text references profiles(legacy_id) on delete set null,
  user_name text,
  "timestamp" timestamptz not null default now(),
  ref_type text,
  ref_id text,
  note text
);

-- ---------------------------------------------------------------------------
-- 4) Compras
-- ---------------------------------------------------------------------------
create table if not exists purchase_orders (
  id text primary key,
  code text unique not null,
  supplier_id text references suppliers(id) on delete set null,
  items jsonb not null default '[]'::jsonb, -- [{id,isNew,productId,variationId,newName,newCategoryId,qtyOrdered,qtyReceived}]
  status text not null,
  expected_date timestamptz,
  created_at timestamptz not null default now(),
  created_by text references profiles(legacy_id) on delete set null
);

create table if not exists storage_tasks (
  id text primary key,
  po_id text references purchase_orders(id) on delete cascade,
  po_item_id text,
  product_id text references products(id) on delete set null,
  variation_id text,
  qty_pending numeric,
  suggested_location_id text references locations(id) on delete set null,
  status text
);

-- ---------------------------------------------------------------------------
-- 5) Vendas
-- ---------------------------------------------------------------------------
create table if not exists sales_orders (
  id text primary key,
  code text unique not null,
  channel text not null, -- LOJA | ONLINE
  customer_id text references customers(id) on delete set null,
  items jsonb not null default '[]'::jsonb, -- [{id,productId,variationId,qty,locationId,separated,conferred}]
  status text not null,
  priority text,
  created_at timestamptz not null default now(),
  created_by text references profiles(legacy_id) on delete set null
);

create table if not exists payments (
  id text primary key,
  sales_order_id text references sales_orders(id) on delete cascade,
  amount numeric(12,2),
  method text,
  note text,
  created_at timestamptz not null default now(),
  created_by text references profiles(legacy_id) on delete set null
);

create table if not exists shipments (
  id text primary key,
  sales_order_id text references sales_orders(id) on delete cascade,
  tracking_code text,
  status text,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6) Auditoria e metadados
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id text primary key,
  "timestamp" timestamptz not null default now(),
  user_id text references profiles(legacy_id) on delete set null,
  user_name text,
  action text,
  entity_type text,
  entity_id text,
  details text
);

-- Uma única linha ("main") guarda o nome da organização e os contadores usados
-- para gerar códigos legíveis (SKU-0001, OC-0007, PED-0003, IDs internos
-- como "prod-3") — equivalente ao antigo STATE.meta.
create table if not exists org_meta (
  id text primary key default 'main',
  org_name text not null default 'DARVIK',
  seq jsonb not null default '{}'::jsonb
);
insert into org_meta (id, org_name) values ('main', 'DARVIK') on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 7) Controle de acesso por tela (mesma lógica de canAccessRoute() do
--    front-end, agora validada também no banco)
-- ---------------------------------------------------------------------------
create or replace function has_screen_access(screen text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  prof record;
  role_defaults jsonb := '{
    "produtos": ["OPERADOR_ESTOQUE","OPERADOR_CADASTROS"],
    "categorias": ["OPERADOR_ESTOQUE","OPERADOR_CADASTROS"],
    "localizacoes": ["OPERADOR_ESTOQUE","OPERADOR_CADASTROS"],
    "fornecedores": ["OPERADOR_ESTOQUE","OPERADOR_CADASTROS"],
    "clientes": ["VENDEDOR"],
    "compras": ["OPERADOR_ESTOQUE","COMPRADOR"],
    "recebimento": ["OPERADOR_ESTOQUE"],
    "estoque": ["OPERADOR_ESTOQUE"],
    "consulta-estoque": ["OPERADOR_ESTOQUE"],
    "movimentacoes": ["OPERADOR_ESTOQUE"],
    "vendas": ["VENDEDOR"],
    "pagamento": ["VENDEDOR"],
    "expedicao": ["VENDEDOR","OPERADOR_ESTOQUE"],
    "usuarios": [],
    "historico": []
  }'::jsonb;
begin
  select * into prof from profiles where id = auth.uid();
  if prof.id is null then return false; end if;
  if prof.role = 'ADMIN' then return true; end if;
  if prof.custom_permissions is not null then
    return screen = any(prof.custom_permissions);
  end if;
  if role_defaults ? screen then
    return (role_defaults->screen) ? prof.role;
  end if;
  return false;
end;
$$;

create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce((select role = 'ADMIN' from profiles where id = auth.uid()), false);
$$;

-- has_screen_access precisa poder ser chamada tanto pelas políticas de RLS
-- quanto diretamente pelo front-end/Edge Function via RPC (supabase.rpc(...)).
grant execute on function has_screen_access(text) to authenticated;
grant execute on function is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Row Level Security
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
alter table categories enable row level security;
alter table suppliers enable row level security;
alter table customers enable row level security;
alter table products enable row level security;
alter table locations enable row level security;
alter table stock enable row level security;
alter table stock_movements enable row level security;
alter table purchase_orders enable row level security;
alter table storage_tasks enable row level security;
alter table sales_orders enable row level security;
alter table payments enable row level security;
alter table shipments enable row level security;
alter table audit_log enable row level security;
alter table org_meta enable row level security;

-- profiles: qualquer pessoa logada pode ver nome/função de todo mundo (igual
-- ao sistema antigo, que já mostrava isso a qualquer usuário); só ADMIN pode
-- alterar (criar/editar é feito pela Edge Function "manage-user", que usa a
-- chave de serviço e ignora RLS — aqui só liberamos UPDATE direto de campos
-- simples, como ativar/desativar, feito pelo próprio front-end).
create policy "profiles_select_authenticated" on profiles for select to authenticated using (true);
create policy "profiles_update_admin" on profiles for update to authenticated using (is_admin()) with check (is_admin());

-- Tabelas de leitura ampla (qualquer autenticado) + escrita por permissão de tela
create policy "categories_select" on categories for select to authenticated using (true);
create policy "categories_write" on categories for all to authenticated using (has_screen_access('categorias')) with check (has_screen_access('categorias'));

create policy "suppliers_select" on suppliers for select to authenticated using (true);
create policy "suppliers_write" on suppliers for all to authenticated using (has_screen_access('fornecedores')) with check (has_screen_access('fornecedores'));

create policy "customers_select" on customers for select to authenticated using (true);
create policy "customers_write" on customers for all to authenticated using (has_screen_access('clientes')) with check (has_screen_access('clientes'));

create policy "products_select" on products for select to authenticated using (true);
create policy "products_write" on products for all to authenticated using (has_screen_access('produtos')) with check (has_screen_access('produtos'));

create policy "locations_select" on locations for select to authenticated using (true);
create policy "locations_write" on locations for all to authenticated using (has_screen_access('localizacoes')) with check (has_screen_access('localizacoes'));

create policy "stock_select" on stock for select to authenticated using (true);
create policy "stock_write" on stock for all to authenticated using (has_screen_access('estoque') or has_screen_access('recebimento')) with check (has_screen_access('estoque') or has_screen_access('recebimento'));

create policy "stock_movements_select" on stock_movements for select to authenticated using (true);
create policy "stock_movements_write" on stock_movements for all to authenticated using (has_screen_access('estoque') or has_screen_access('recebimento') or has_screen_access('movimentacoes')) with check (has_screen_access('estoque') or has_screen_access('recebimento') or has_screen_access('movimentacoes'));

create policy "purchase_orders_select" on purchase_orders for select to authenticated using (true);
create policy "purchase_orders_write" on purchase_orders for all to authenticated using (has_screen_access('compras') or has_screen_access('recebimento')) with check (has_screen_access('compras') or has_screen_access('recebimento'));

create policy "storage_tasks_select" on storage_tasks for select to authenticated using (true);
create policy "storage_tasks_write" on storage_tasks for all to authenticated using (has_screen_access('recebimento')) with check (has_screen_access('recebimento'));

create policy "sales_orders_select" on sales_orders for select to authenticated using (true);
create policy "sales_orders_write" on sales_orders for all to authenticated using (has_screen_access('vendas') or has_screen_access('expedicao')) with check (has_screen_access('vendas') or has_screen_access('expedicao'));

create policy "payments_select" on payments for select to authenticated using (true);
create policy "payments_write" on payments for all to authenticated using (has_screen_access('pagamento')) with check (has_screen_access('pagamento'));

create policy "shipments_select" on shipments for select to authenticated using (true);
create policy "shipments_write" on shipments for all to authenticated using (has_screen_access('expedicao')) with check (has_screen_access('expedicao'));

-- audit_log: qualquer autenticado pode ler (igual ao Dashboard hoje, que
-- mostra "atividade recente" a todo mundo) e inserir (toda ação registra
-- quem fez, seja qual for o papel); ninguém pode alterar/apagar um registro
-- já gravado (log é histórico, não editável).
create policy "audit_log_select" on audit_log for select to authenticated using (true);
create policy "audit_log_insert" on audit_log for insert to authenticated with check (true);

-- org_meta: leitura ampla; escrita liberada para qualquer autenticado (guarda
-- só nome da empresa/contadores de código, nada sensível) — na prática só
-- muda quando alguém cadastra algo novo (o contador avança).
create policy "org_meta_select" on org_meta for select to authenticated using (true);
create policy "org_meta_write" on org_meta for update to authenticated using (true) with check (true);

-- login_lookup (a view) precisa funcionar ANTES do login (é o que traduz o
-- usuário digitado para o e-mail interno usado no Supabase Auth). Por padrão
-- uma view do Postgres já roda com os privilégios de quem a criou (não de
-- quem consulta), então ela consegue ler "profiles" mesmo sem sessão logada
-- — não precisa (e não deve) ligar "security_invoker" nela. Ela só devolve
-- login/e-mail sintético de usuários ativos, nunca senha ou qualquer outro
-- dado sensível.
grant select on login_lookup to anon, authenticated;
