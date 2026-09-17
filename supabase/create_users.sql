-- ============================================================================
-- DARVIK — Criação dos 4 usuários reais (Supabase Auth), 100% por SQL
-- ============================================================================
-- Como rodar: painel do Supabase → seu projeto → SQL Editor → cole este
-- arquivo inteiro → Run. Só depois de já ter rodado o schema.sql.
--
-- Por que isso funciona sem instalar nada e sem a chave "service_role":
-- o SQL Editor do Supabase roda com privilégio total no banco (o mesmo
-- nível que a chave service_role dá pela API) — então dá para criar as
-- contas de autenticação (tabelas internas auth.users/auth.identities)
-- diretamente por aqui, sem precisar de nenhum script local nem chave
-- secreta. É o mesmo princípio usado no sistema coletor (tudo por SQL),
-- só que aqui continuamos usando o Supabase Auth de verdade por baixo —
-- então a segurança fica igual à combinada (login real, RLS por usuário),
-- não a versão totalmente aberta do coletor.
--
-- Todo mundo é criado com a senha temporária "1234" — a mesma usada desde
-- a primeira migração de login deste sistema (Versão 6). É seguro rodar
-- este script apenas uma vez; rodar de novo dá erro de "já existe"
-- (login/e-mail duplicado) sem quebrar nada, mas não crie usuários
-- duplicados de propósito.
-- ============================================================================

do $$
declare
  v_id uuid;
  r record;
begin
  for r in select * from (values
    ('u1',     'administrador',    '1234', 'Administrador',     'ADMIN',             null::text[]),
    ('user-1', 'inventra.oficial', '1234', 'INVENTRA.OFICIAL',  'ADMIN',             null::text[]),
    ('user-2', 'm.brito',          '1234', 'Messias',           'OPERADOR_ESTOQUE',  array['recebimento','estoque','consulta-estoque','movimentacoes','expedicao']),
    ('user-3', 'y.brito',          '1234', 'Yasmin',            'COMPRADOR',         array['localizacoes','fornecedores','categorias','produtos','compras','clientes'])
  ) as t(legacy_id, login, password, name, role, custom_permissions)
  loop
    v_id := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token,
      email_change_token_new, email_change, is_super_admin, is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_id, 'authenticated', 'authenticated',
      r.login || '@darvik.local',
      crypt(r.password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(), now(), '', '', '', '', false, false, false
    );

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_id, v_id::text,
      jsonb_build_object('sub', v_id::text, 'email', r.login || '@darvik.local',
                          'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );

    insert into profiles (id, legacy_id, name, login, role, custom_permissions, active)
    values (v_id, r.legacy_id, r.name, r.login, r.role, r.custom_permissions, true);
  end loop;
end $$;

-- Conferência rápida: deve devolver as 4 linhas criadas.
select legacy_id, login, name, role, custom_permissions from profiles order by legacy_id;
