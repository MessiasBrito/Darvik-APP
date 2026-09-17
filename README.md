# DARVIK — Sistema de Estoque (versão com banco de dados real)

Este projeto é a versão do sistema DARVIK que roda como um **site normal**,
hospedado de graça no **GitHub Pages**, guardando os dados num banco de
dados de verdade no **Supabase** (em vez de tudo ficar dentro de um único
link do Claude, como na versão anterior).

O visual, os menus e todas as telas continuam exatamente iguais. O que
mudou foi "por baixo do capô": onde os dados ficam guardados e como o
login funciona.

**Todo o processo abaixo é copiar e colar** — nada de instalar programa,
nada de terminal, nada de chave secreta. É o mesmo método usado no
sistema coletor: eu gero os arquivos, você cola no Supabase e no GitHub.

---

## O que muda para quem usa o sistema

- O endereço do sistema passa a ser algo como `https://SEU-USUARIO.github.io/darvik-app/`
  (grátis, fornecido pelo próprio GitHub — não é um domínio personalizado
  comprado, é o endereço padrão do GitHub Pages).
- O login continua sendo usuário + senha, na mesma tela de sempre.
- **Todo mundo vai precisar logar de novo com uma senha temporária**
  (`1234`, veja o Passo 3) porque as senhas antigas usavam outro sistema
  de segurança que não pode ser convertido. Assim que entrarem, devem
  trocar a senha o quanto antes — ainda não existe uma tela de "trocar
  minha senha" dentro do sistema (está listado nas pendências, no fim
  deste documento).
- Todos os dados atuais (produtos, pedidos de compra e venda, histórico,
  etc.) já vêm migrados — nada começa vazio.

---

## ✅ Onde as coisas estão agora

- Você já criou um projeto Supabase **só para o DARVIK**, chamado
  **DarvikControl** (organização "Darvik-Controle de estoque") — separado
  de propósito do projeto **INVENTRA**, que é o banco de dados do seu
  outro sistema, o "coletor". Os dois nunca se misturam.
- **Já preenchi a URL do projeto DarvikControl em `js/config.js`** — só
  falta você colar a chave pública (`anon`), no Passo 5.
- Login e senha continuam usando o Supabase Auth de verdade (não é o
  método totalmente aberto do coletor) — mas o jeito de configurar isso
  também virou só copiar e colar um arquivo SQL (Passo 3), sem precisar
  de nenhuma chave secreta nem de instalar nada no seu computador.

---

## Passo a passo (tudo copiar e colar)

### Passo 1 — Projeto Supabase ✅ já feito (você criou o "DarvikControl")

### Passo 2 — Criar as tabelas e as regras de segurança

1. No painel do Supabase, abra o projeto **DarvikControl** (não o
   INVENTRA) e vá em **SQL Editor**.
2. Abra o arquivo `supabase/schema.sql` deste pacote, copie todo o
   conteúdo e cole no SQL Editor. Rode (**Run**).
3. Isso cria as 15 tabelas do DARVIK e as regras de segurança (Row Level
   Security) — a mesma lógica de permissões por tela que o sistema já
   tinha, agora validada também dentro do banco.

### Passo 3 — Criar os 4 usuários reais

1. Ainda no **SQL Editor** do projeto DarvikControl, abra o arquivo
   `supabase/create_users.sql` deste pacote, copie tudo e cole. Rode.
2. Isso cria as contas de login de verdade dos 4 usuários que já existiam
   (Administrador, INVENTRA.OFICIAL, Messias e Yasmin), todos com a senha
   temporária **`1234`** — cada um deve trocar assim que possível.
3. A última linha do script mostra uma tabela de conferência com os 4
   usuários criados — confira se os 4 aparecem certinhos.

Isso substitui totalmente o script local que eu tinha preparado antes —
não precisa de Node.js, terminal, nem da chave secreta `service_role`.

### Passo 4 — Trazer os dados que já existiam (produtos, pedidos, histórico...)

Só depois do Passo 3 (os usuários precisam existir primeiro):

1. Volte ao **SQL Editor** do projeto DarvikControl.
2. Abra `supabase/seed.sql`, copie tudo e cole. Rode.
3. Isso preenche categorias, fornecedores, produtos, localizações,
   estoque, pedidos de compra e venda, e todo o histórico de auditoria com
   os dados reais que já existiam no sistema.

### Passo 5 — Conectar o site à sua chave pública

A URL já está preenchida em `js/config.js`. Falta só a chave pública:

1. No projeto DarvikControl → **Project Settings → API**, copie a chave
   **`anon public`** (não a `service_role`).
2. Abra `js/config.js` neste projeto e cole no lugar de
   `cole-aqui-a-chave-anon-public-do-projeto-DarvikControl`.

   Essa chave é feita para ser pública — pode ficar tranquila no GitHub.
   Quem protege os dados de verdade são as regras criadas no Passo 2.

### Passo 6 — Publicar a função que cria/edita usuários (opcional por enquanto)

A tela "Usuários" dentro do sistema (criar um novo usuário, trocar login
ou senha de alguém, depois do lançamento) usa uma pequena função que roda
dentro do Supabase — ela existe porque essa operação usa uma chave
secreta que nunca pode aparecer no site público.

**Se preferir pular este passo por enquanto:** os 4 usuários já foram
criados no Passo 3, então o sistema funciona normalmente sem esta função
— ela só faz falta se alguém tentar usar a tela "Usuários" para
adicionar uma quinta pessoa mais adiante. Quando esse dia chegar, é só me
pedir que eu gero um novo `create_users.sql` (ou um script parecido) só
com a pessoa nova, no mesmo estilo de copiar e colar.

Se quiser publicar mesmo assim, ainda pelo painel (sem instalar nada):

1. No projeto DarvikControl, vá em **Edge Functions → Create a new
   function**, nomeie como `manage-user`.
2. Cole o conteúdo de `supabase/functions/manage-user/index.ts` no editor
   e publique (**Deploy**).
3. Em **Edge Functions → manage-user → Settings** (ou na seção de
   variáveis/segredos do projeto), confirme que existem as variáveis
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_ANON_KEY` — o
   Supabase costuma preenchê-las automaticamente; se não preencher, copie
   os valores de **Project Settings → API**.

### Passo 7 — Publicar no GitHub Pages (grátis)

Este será um repositório novo, separado do repositório do coletor. É só
seu, porque exige a sua própria conta do GitHub.

1. Crie um repositório novo no GitHub (pode ser público ou privado — os
   dois funcionam com o GitHub Pages).
2. Suba todos os arquivos desta pasta para o repositório (pelo site do
   GitHub, em "Add file → Upload files", ou por linha de comando com
   `git add`, `git commit`, `git push`).
3. No repositório, vá em **Settings → Pages**.
4. Em "Build and deployment", escolha **Deploy from a branch**, selecione
   a branch `main` e a pasta `/ (root)`. Salve.
5. Espere 1-2 minutos. O GitHub vai mostrar o endereço do site, algo como
   `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

Pronto — esse é o endereço definitivo e gratuito do sistema.

---

## Sobre domínio personalizado

O endereço `SEU-USUARIO.github.io/...` já é grátis e definitivo — não
expira e não tem custo. Se no futuro você quiser um domínio próprio (por
exemplo `estoque.suaempresa.com.br`), isso exige comprar o domínio
separadamente (em serviços como Registro.br, GoDaddy, Namecheap etc.) e
depois apontá-lo para o GitHub Pages nas configurações do repositório —
o GitHub Pages em si continua sendo grátis, só o domínio tem um custo
anual cobrado por quem vende domínios, não pelo GitHub.

---

## O que é seguro e o que ficou registrado como pendência

**Seguro por design:**
- A chave pública (`anon`) em `js/config.js` é feita para ficar exposta.
- O login usa o Supabase Auth de verdade — as senhas ficam guardadas
  criptografadas dentro do próprio Supabase, nunca em texto simples.
- Cada tela só pode ser alterada por quem tem permissão para ela — essa
  regra é aplicada também dentro do banco (Row Level Security), não só
  escondendo botões na tela.
- `create_users.sql` cria as contas diretamente pelo SQL Editor, que já
  roda com privilégio total dentro do seu próprio projeto — por isso não
  precisa de nenhuma chave secreta separada para esse passo único.

**Pendências conhecidas (próximos passos sugeridos):**
- A Edge Function `manage-user` (Passo 6) ainda não publicada por padrão
  — sem ela, criar um usuário novo pela tela "Usuários" não funciona
  ainda (editar/criar continua possível por SQL, comigo gerando o script
  quando precisar).
- Não existe ainda uma tela de "trocar minha senha" dentro do sistema —
  hoje, para trocar a senha de alguém, é preciso usar a tela "Usuários"
  (ou pedir um novo script SQL). Enquanto isso, todos estão com a senha
  temporária `1234` — o ideal é trocar isso o quanto antes.
- Não existe ainda um fluxo de "esqueci minha senha" (recuperação por
  e-mail), porque os logins usam nomes de usuário, não e-mails reais.
- Recomenda-se ativar a autenticação em duas etapas (2FA) da própria
  conta do Supabase (não dos usuários do sistema) para proteger o painel
  administrativo.

---

## Estrutura deste projeto

```
darvik-app/
├── index.html                     página única do sistema
├── css/app.css                    todo o visual (idêntico ao original)
├── js/
│   ├── config.js                  suas credenciais do Supabase (falta só a anon key)
│   └── app.js                     toda a lógica do sistema
├── assets/logo.jpg                logomarca
└── supabase/
    ├── schema.sql                 tabelas + regras de segurança (colar 1x)
    ├── create_users.sql           cria os 4 usuários reais (colar 1x, só SQL)
    ├── seed.sql                   dados reais já existentes (colar após create_users.sql)
    └── functions/manage-user/     função opcional para criar novos usuários pela tela (Passo 6)
```
