/* ============================================================================
   DARVIK — Configuração do Supabase
   ============================================================================
   SUPABASE_URL já preenchido com o projeto "DarvikControl" que você criou
   (organização "Darvik-Controle de estoque"), separado do sistema coletor.

   Falta só a SUPABASE_ANON_KEY — pegue em: painel do Supabase → projeto
   DarvikControl → Project Settings → API → chave "anon public" (a chave
   PÚBLICA — NUNCA use a "service_role" aqui, ela não pode aparecer em
   nenhum arquivo que vai para o GitHub).

   Este arquivo fica público no GitHub Pages junto com o resto do site, e
   isso é esperado: a chave "anon" foi feita para ser pública. Quem protege
   os dados de verdade é a Row Level Security (RLS) configurada no
   supabase/schema.sql, não o segredo desta chave.
   ============================================================================ */
window.DARVIK_CONFIG = {
  SUPABASE_URL: 'https://ddundjcmviggfaugbyuv.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_INIMiFa7N2_pwspoq4ekAQ_vub3lQIz'
};
