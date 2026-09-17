// ============================================================================
// DARVIK — Edge Function "manage-user"
// ============================================================================
// Por que isto precisa existir: criar um login novo, trocar a senha de outra
// pessoa, ou mudar o "usuário (login)" de alguém envolve mexer no Supabase
// Auth com a chave de serviço (service_role) — uma chave que NUNCA pode
// chegar ao navegador (senão qualquer pessoa poderia usá-la para virar
// administrador do sistema inteiro). Uma Edge Function roda dentro do
// Supabase, não no navegador do usuário, então é o único lugar seguro para
// usar essa chave.
//
// Segurança: a função primeiro confere, usando o token de quem chamou, se
// essa pessoa realmente tem acesso à tela "Usuários" (has_screen_access) —
// exatamente a mesma regra usada em todo o resto do sistema. Só depois disso
// ela usa a chave de serviço para criar/alterar a conta.
//
// Como publicar: veja o README.md na raiz do projeto ("Passo 5").
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function emailFor(login: string) {
  return `${login}@darvik.local`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!callerToken) return json({ error: 'Faça login novamente.' }, 401);

    // Cliente "como o chamador" — usado só para confirmar quem ele é e se
    // tem permissão. Nunca usamos isto para escrever nada sensível.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${callerToken}` } },
    });
    const { data: callerUserData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerUserData?.user) return json({ error: 'Sessão inválida.' }, 401);

    const { data: allowed, error: rpcErr } = await callerClient.rpc('has_screen_access', { screen: 'usuarios' });
    if (rpcErr) return json({ error: 'Não foi possível validar sua permissão.' }, 500);
    if (!allowed) return json({ error: 'Você não tem permissão para gerenciar usuários.' }, 403);

    const body = await req.json();
    const action = body.action;

    // Cliente "de serviço" — só a partir daqui, já confirmado que quem pediu
    // tem acesso administrativo.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (action === 'create') {
      const { name, login, role, customPermissions, password } = body;
      if (!name || !login || !role || !password) return json({ error: 'Preencha nome, usuário, função e senha.' }, 400);

      const { data: dup } = await admin.from('profiles').select('id').eq('login', login.toLowerCase()).maybeSingle();
      if (dup) return json({ error: 'Já existe um usuário com esse login.' }, 400);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: emailFor(login.toLowerCase()),
        password,
        email_confirm: true,
      });
      if (createErr) return json({ error: createErr.message }, 400);

      const { data: seqRow } = await admin.from('org_meta').select('seq').eq('id', 'main').single();
      const seq = seqRow?.seq || {};
      const n = (seq.user || 1);
      const legacyId = 'user-' + n;
      await admin.from('org_meta').update({ seq: { ...seq, user: n + 1 } }).eq('id', 'main');

      const { error: insertErr } = await admin.from('profiles').insert({
        id: created.user.id,
        legacy_id: legacyId,
        name,
        login: login.toLowerCase(),
        role,
        custom_permissions: role === 'ADMIN' ? null : customPermissions,
        active: true,
      });
      if (insertErr) return json({ error: insertErr.message }, 400);

      return json({ id: legacyId });
    }

    if (action === 'update') {
      const { legacyId, name, login, role, customPermissions, password } = body;
      if (!legacyId) return json({ error: 'Usuário não informado.' }, 400);

      const { data: profile, error: findErr } = await admin.from('profiles').select('id, login').eq('legacy_id', legacyId).single();
      if (findErr || !profile) return json({ error: 'Usuário não encontrado.' }, 404);

      if (login && login.toLowerCase() !== profile.login) {
        const { data: dup } = await admin.from('profiles').select('id').eq('login', login.toLowerCase()).neq('id', profile.id).maybeSingle();
        if (dup) return json({ error: 'Já existe um usuário com esse login.' }, 400);
        const { error: emailErr } = await admin.auth.admin.updateUserById(profile.id, { email: emailFor(login.toLowerCase()) });
        if (emailErr) return json({ error: emailErr.message }, 400);
      }

      if (password) {
        const { error: passErr } = await admin.auth.admin.updateUserById(profile.id, { password });
        if (passErr) return json({ error: passErr.message }, 400);
      }

      const { error: updateErr } = await admin.from('profiles').update({
        name, login: login ? login.toLowerCase() : undefined, role,
        custom_permissions: role === 'ADMIN' ? null : customPermissions,
      }).eq('id', profile.id);
      if (updateErr) return json({ error: updateErr.message }, 400);

      return json({ id: legacyId });
    }

    return json({ error: 'Ação desconhecida.' }, 400);
  } catch (err) {
    return json({ error: (err as Error).message || 'Erro inesperado.' }, 500);
  }
});
