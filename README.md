# Vigente

Controle de contratos com alertas de vencimento e renovação automática, para pequenas e médias empresas.

**O que já funciona**
- Site de vendas (página inicial, como funciona, preços mensal/anual, dúvidas)
- Cadastro e login (senha com bcrypt, sessão JWT de 30 dias)
- Painel: régua de prazos, indicadores, busca, filtros, adicionar/editar/excluir contratos
- Limite por plano: Starter 10, Pro 200, Business ilimitado
- Assinatura pelo Stripe Checkout + webhook que ativa/cancela o plano
- Alertas por e-mail dentro da janela de aviso, repetidos a cada 7 dias
- Testes automáticos da API (`npm test`)

## Rodar no seu PC

Precisa do Node.js 22 ou mais novo.

```bash
npm install
cp .env.example .env   # edite os valores
npm start              # abre em http://localhost:3000
```

Sem chaves do Stripe e SMTP o app funciona: os pagamentos respondem "não configurado" e os alertas aparecem no terminal.

## O que você precisa fornecer (nada foi inventado)

| Variável | Onde conseguir |
|---|---|
| `JWT_SECRET` | Gere: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_URL` | Seu domínio, ex.: `https://vigente.app` |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (use `sk_test_` até testar tudo) |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | Stripe → Products → crie "Pro" (R$ 49/mês) e "Business" (R$ 149/mês) e copie o `price_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → endpoint `APP_URL/api/webhooks/stripe`, eventos `checkout.session.completed` e `customer.subscription.deleted` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Resend, Brevo ou Amazon SES (todos dão SMTP) |

## Publicar

Qualquer serviço que rode Node com disco persistente: **Railway**, **Render** ou **Fly.io**.
1. Suba esta pasta para um repositório no GitHub.
2. Crie o serviço apontando para o repositório, comando `npm start`.
3. Adicione um volume e defina `DB_PATH=/data/vigente.db`.
4. Configure as variáveis da tabela acima e o domínio.

Também há um `Dockerfile` pronto.

## Estrutura

```
server.js          API, banco SQLite, Stripe, alertas
public/index.html  site + painel (abre em modo prévia se não houver API)
test/api.test.js   testes de ponta a ponta da API
```

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/register` | `{name,email,password,company}` |
| POST | `/api/auth/login` | `{email,password}` |
| GET | `/api/me` | usuário logado |
| GET/POST | `/api/contracts` | listar / criar |
| PUT/DELETE | `/api/contracts/:id` | editar / excluir |
| POST | `/api/billing/checkout` | `{plan:"pro"|"business"}` → URL do Stripe |
| POST | `/api/webhooks/stripe` | eventos do Stripe |

## Próximos passos sugeridos
- Termos de uso e política de privacidade revisados por um advogado (LGPD/GDPR)
- Versões em inglês e espanhol e cobrança em USD/EUR
- Portal do cliente do Stripe para trocar cartão e cancelar
- Vários usuários por empresa (prometido no Business)
