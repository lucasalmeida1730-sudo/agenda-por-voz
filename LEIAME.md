# Agenda por Voz

App de agenda para celular: o cliente toca no microfone, fala o compromisso
("dentista amanhã às 9h", "reunião com a Ana sexta às 15h no escritório")
e o evento entra **direto no calendário do próprio app**.

## Como funciona

1. O celular grava o áudio e envia para o servidor.
2. O servidor transcreve o áudio (OpenAI `gpt-4o-mini-transcribe`).
3. O Claude (`claude-opus-5-5`) lê o texto, entende datas como "sexta que vem"
   e devolve o(s) compromisso(s) num formato fixo.
4. Os eventos são salvos no banco do app (SQLite em `data/agenda.db`) e aparecem no calendário.
   Aparece um aviso com o que foi entendido e o botão **Desfazer**.

**Perguntar a agenda:** o cliente também pode falar "o que eu tenho dia 15?", "tenho algo amanhã?"
ou "como está minha semana?". O app responde com os compromissos daquele dia/período, lê a
resposta em voz alta e abre o dia no calendário. A resposta é montada com os dados reais do banco
(a IA só entende qual data foi perguntada, não inventa compromissos).

Também dá para: digitar em vez de falar (botão ⌨), criar/editar/excluir eventos na mão,
e um áudio pode ter mais de um compromisso.

## Rodar no computador

Precisa de Node.js 22.13 ou mais novo.

```powershell
npm install
```

```powershell
Copy-Item .env.example .env
```

Abra o `.env` e preencha `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` e troque o `APP_PIN`.

```powershell
npm start
```

Abra http://localhost:3000 e entre com o PIN.

## Colocar no ar para o cliente

O microfone do celular **só funciona em HTTPS**, então o app precisa estar hospedado
(não dá para o cliente usar o `localhost` do seu PC).

Opção simples: **Railway** (ou Render com disco persistente, ou uma VPS):

1. Suba esta pasta para um repositório no GitHub.
2. Crie um projeto no Railway a partir do repositório (ele detecta Node e roda `npm start`).
3. Em *Variables*, coloque as mesmas variáveis do `.env`.
4. Adicione um **Volume** montado em `/app/data` — é onde fica o banco. Sem volume, os
   compromissos somem a cada deploy.
5. O Railway gera uma URL `https://...`. Mande para o cliente.

No celular do cliente:
- **iPhone (Safari):** abrir o link → Compartilhar → "Adicionar à Tela de Início".
- **Android (Chrome):** abrir o link → menu ⋮ → "Instalar app" / "Adicionar à tela inicial".

Fica com ícone e abre em tela cheia, como um app normal.

## Custos (aproximado)

- Transcrição: centavos por hora de áudio (um áudio de 10 s custa uma fração de centavo).
- Claude: alguns centavos de real por compromisso.
- Hospedagem: Railway a partir de ~US$ 5/mês.

## Arquivos

- `server.js` — servidor, API, transcrição, IA e banco.
- `public/` — o app (calendário, gravação, PWA).
- `data/agenda.db` — banco de dados (criado sozinho; faça backup).

## Segurança

O acesso é protegido por um PIN (`APP_PIN`). É pensado para **um cliente** usar sozinho.
Se for vender para vários clientes, o próximo passo é ter login por usuário e
uma agenda separada para cada um.
