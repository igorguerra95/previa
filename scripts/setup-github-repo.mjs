/**
 * Automação Central e Fallback de Configuração do GitHub Pages
 * Repositório Central: modelo-previas
 *
 * Modos de operação:
 *  1. Modo Central (PAGES_AUTOMATION_TOKEN presente):
 *     - Identifica o proprietário autenticado e varre os repositórios derivados recentes
 *       (ou configura TARGET_REPO específico).
 *     - Habilita GitHub Actions, define permissões de workflow "Read and write",
 *       ativa o GitHub Pages com build_type: "workflow" e dispara o deploy.yml.
 *
 *  2. Modo Fallback (sem PAGES_AUTOMATION_TOKEN, usando GITHUB_TOKEN + CURRENT_REPOSITORY):
 *     - Executado automaticamente em repositórios derivados sem exigir cadastro de PAT.
 *     - Configura apenas o repositório atual (CURRENT_REPOSITORY).
 *     - Pula chamadas exclusivas de PAT (/user, /user/repos, /actions/permissions*).
 *     - Tenta habilitar/validar o GitHub Pages via GITHUB_TOKEN sem falhar o workflow
 *       com código 1 por ausência de PAGES_AUTOMATION_TOKEN.
 */

const PAT_TOKEN = (process.env.PAGES_AUTOMATION_TOKEN || '').trim();
const NATIVE_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const CURRENT_REPOSITORY = (process.env.CURRENT_REPOSITORY || '').trim();
const TARGET_REPO = (process.env.TARGET_REPO || '').trim();
const TARGET_OWNER = (process.env.TARGET_OWNER || '').trim();

const USE_PAT_MODE = Boolean(PAT_TOKEN);
const ACTIVE_TOKEN = PAT_TOKEN || NATIVE_TOKEN;

if (!ACTIVE_TOKEN) {
  console.error('❌ ERRO: Nenhum token disponível (nem PAGES_AUTOMATION_TOKEN nem GITHUB_TOKEN).');
  process.exit(1);
}

if (!USE_PAT_MODE && !CURRENT_REPOSITORY) {
  console.log('ℹ️ PAGES_AUTOMATION_TOKEN não configurado e CURRENT_REPOSITORY ausente. Nada a executar.');
  process.exit(0);
}

const headers = {
  'Authorization': `Bearer ${ACTIVE_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'modelo-previas-automator'
};

async function ghRequest(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });

  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 403 && remaining === '0') {
    const resetTime = new Date(Number(response.headers.get('x-ratelimit-reset')) * 1000).toLocaleTimeString('pt-BR');
    console.error(`⚠️ ATENÇÃO: Limite de requisições da API do GitHub atingido (Rate Limit). O limite será resetado às ${resetTime}.`);
  }

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    ok: response.ok,
    data
  };
}

async function getAuthenticatedUser() {
  const res = await ghRequest('/user');
  if (!res.ok) {
    throw new Error(`Falha ao autenticar token no GitHub (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data.login;
}

async function listCandidateRepositories(owner, authenticatedUser) {
  let endpoint = `/user/repos?sort=updated&direction=desc&per_page=50&affiliation=owner`;

  if (owner && authenticatedUser && owner.toLowerCase() !== authenticatedUser.toLowerCase()) {
    endpoint = `/users/${owner}/repos?sort=updated&direction=desc&per_page=50`;
  }

  const res = await ghRequest(endpoint);
  if (!res.ok) {
    throw new Error(`Falha ao listar repositórios do usuário "${owner}" (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }

  const repos = Array.isArray(res.data) ? res.data : [];

  return repos.filter(repo => {
    if (repo.name === 'modelo-previas') return false;
    if (repo.fork) return false;
    if (repo.archived) return false;
    return true;
  });
}

async function checkDeployWorkflowExists(owner, repo, branch) {
  const res = await ghRequest(`/repos/${owner}/${repo}/contents/.github/workflows/deploy.yml?ref=${branch}`);
  return res.ok;
}

async function configureRepository(owner, repo, isPatMode) {
  console.log(`\n======================================================`);
  console.log(`🚀 Verificando repositório: ${owner}/${repo} (${isPatMode ? 'Modo Central PAT' : 'Modo Fallback GITHUB_TOKEN'})`);
  console.log(`======================================================`);

  const results = {
    repo: `${owner}/${repo}`,
    alreadyConfigured: false,
    actionsEnabled: false,
    workflowPermissionsSet: false,
    pagesConfigured: false,
    deployTriggered: false,
    isPrivate: false,
    errors: []
  };

  // 1. Obter informações básicas do repositório
  const repoRes = await ghRequest(`/repos/${owner}/${repo}`);
  if (!repoRes.ok) {
    const msg = `Não foi possível acessar o repositório ${owner}/${repo} (HTTP ${repoRes.status}): ${JSON.stringify(repoRes.data)}`;
    console.error(`❌ ${msg}`);
    results.errors.push(msg);
    return results;
  }

  const defaultBranch = repoRes.data.default_branch || 'main';
  const isPrivate = Boolean(repoRes.data.private);
  results.isPrivate = isPrivate;

  console.log(`ℹ️ Repositório: ${repoRes.data.full_name} | Branch: ${defaultBranch} | Visibilidade: ${isPrivate ? 'Privado' : 'Público'}`);

  // 2. Verificar se é um repositório baseado neste modelo (possui deploy.yml)
  const hasDeployWorkflow = await checkDeployWorkflowExists(owner, repo, defaultBranch);
  if (!hasDeployWorkflow) {
    console.log(`ℹ️ Repositório ${owner}/${repo} não possui .github/workflows/deploy.yml. Pulando.`);
    return results;
  }
  console.log(`✅ Workflow .github/workflows/deploy.yml identificado.`);

  // 3. Verificar estado atual do GitHub Pages e do último deploy
  const pagesCheck = await ghRequest(`/repos/${owner}/${repo}/pages`);
  const runsRes = await ghRequest(`/repos/${owner}/${repo}/actions/runs?per_page=5`);
  const runs = runsRes.ok && runsRes.data.workflow_runs ? runsRes.data.workflow_runs : [];
  const latestDeployRun = runs.find(r => r.path?.includes('deploy.yml') || r.name?.includes('Deploy') || r.name?.includes('Pages'));

  const isPagesReady = pagesCheck.ok && pagesCheck.data.build_type === 'workflow';
  const isDeploySuccess = latestDeployRun && latestDeployRun.conclusion === 'success';

  if (isPagesReady && isDeploySuccess) {
    console.log(`✅ Repositório já está 100% configurado com Pages ativo e deploy bem-sucedido.`);
    console.log(`🌐 URL Pública: ${pagesCheck.data.html_url}`);
    results.alreadyConfigured = true;
    results.pagesConfigured = true;
    results.actionsEnabled = true;
    results.workflowPermissionsSet = true;
    results.deployTriggered = true;
    return results;
  }

  let pagesJustActivated = false;

  // 4 e 5. Permissões de Actions (exclusivo de PAT; pulado no fallback com GITHUB_TOKEN)
  if (isPatMode) {
    try {
      const actionsRes = await ghRequest(`/repos/${owner}/${repo}/actions/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          allowed_actions: 'all'
        })
      });

      if (actionsRes.ok || actionsRes.status === 204) {
        console.log(`✅ GitHub Actions habilitado com sucesso.`);
        results.actionsEnabled = true;
      } else {
        const warn = `Não foi possível alterar permissão geral do Actions (HTTP ${actionsRes.status}): ${JSON.stringify(actionsRes.data)}`;
        console.warn(`⚠️ ${warn}`);
        results.errors.push(warn);
      }
    } catch (err) {
      results.errors.push(`Erro ao habilitar Actions: ${err.message}`);
    }

    try {
      const wfPermRes = await ghRequest(`/repos/${owner}/${repo}/actions/permissions/workflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_workflow_permissions: 'write',
          can_approve_pull_request_reviews: true
        })
      });

      if (wfPermRes.ok || wfPermRes.status === 204) {
        console.log(`✅ Permissões de Workflow configuradas para "Read and write permissions".`);
        results.workflowPermissionsSet = true;
      } else {
        const warn = `Aviso ao configurar permissões de workflow (HTTP ${wfPermRes.status}): ${JSON.stringify(wfPermRes.data)}`;
        console.warn(`⚠️ ${warn}`);
        results.errors.push(warn);
      }
    } catch (err) {
      results.errors.push(`Erro ao configurar permissões de workflow: ${err.message}`);
    }
  } else {
    console.log(`ℹ️ Modo Fallback (GITHUB_TOKEN): pulando chamadas exclusivas de PAT (/actions/permissions).`);
  }

  // 6. Configurar GitHub Pages para build_type: "workflow"
  try {
    if (pagesCheck.status === 404) {
      console.log(`ℹ️ GitHub Pages ainda não está ativado (404). Tentando ativar com build_type: "workflow"...`);

      let createPagesRes = await ghRequest(`/repos/${owner}/${repo}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          build_type: 'workflow',
          source: {
            branch: defaultBranch,
            path: '/'
          }
        })
      });

      if (!createPagesRes.ok && createPagesRes.status === 422) {
        createPagesRes = await ghRequest(`/repos/${owner}/${repo}/pages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            build_type: 'workflow'
          })
        });
      }

      if (createPagesRes.ok || createPagesRes.status === 201) {
        // Confirma via GET /pages
        const confirmRes = await ghRequest(`/repos/${owner}/${repo}/pages`);
        if (confirmRes.ok && confirmRes.data.build_type === 'workflow') {
          console.log(`✅ GitHub Pages ativado e confirmado via API (build_type=workflow)!`);
          results.pagesConfigured = true;
          pagesJustActivated = true;
        } else {
          console.log(`⚠️ Pages criado, aguardando propagação (status=${confirmRes.status}).`);
          results.pagesConfigured = true;
          pagesJustActivated = true;
        }
      } else if (!isPatMode && (createPagesRes.status === 403 || createPagesRes.status === 401)) {
        console.log(`ℹ️ GITHUB_TOKEN nativo não tem permissão para criar o site do Pages via REST neste repositório (HTTP ${createPagesRes.status}). O deploy.yml tentará habilitar via configure-pages (enablement: true) ou o repositório central configurará no ciclo de automação.`);
      } else {
        const errDetail = JSON.stringify(createPagesRes.data);
        let msg = `Falha ao ativar GitHub Pages (HTTP ${createPagesRes.status}): ${errDetail}`;

        if (isPrivate && (createPagesRes.status === 422 || createPagesRes.status === 403)) {
          msg = `❌ REPOSITÓRIO PRIVADO: O GitHub Pages em repositórios privados requer plano GitHub Pro, Team ou Enterprise. ` +
                `Altere a visibilidade do repositório para PÚBLICO para publicar gratuitamente.`;
        }

        console.error(msg);
        results.errors.push(msg);
      }
    } else if (pagesCheck.ok) {
      const currentBuildType = pagesCheck.data.build_type;
      console.log(`ℹ️ GitHub Pages já ativo. Tipo de build atual: "${currentBuildType}"`);

      if (currentBuildType !== 'workflow') {
        console.log(`🔄 Atualizando build_type para "workflow"...`);
        const updatePagesRes = await ghRequest(`/repos/${owner}/${repo}/pages`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            build_type: 'workflow'
          })
        });

        if (updatePagesRes.ok || updatePagesRes.status === 204) {
          console.log(`✅ GitHub Pages atualizado para "workflow" com sucesso.`);
          results.pagesConfigured = true;
          pagesJustActivated = true;
        } else if (!isPatMode && (updatePagesRes.status === 403 || updatePagesRes.status === 401)) {
          console.log(`ℹ️ Sem permissão do GITHUB_TOKEN para alterar build_type via REST (HTTP ${updatePagesRes.status}).`);
        } else {
          const errMsg = `Falha ao atualizar GitHub Pages (HTTP ${updatePagesRes.status}): ${JSON.stringify(updatePagesRes.data)}`;
          console.warn(`⚠️ ${errMsg}`);
          results.errors.push(errMsg);
        }
      } else {
        console.log(`✅ GitHub Pages já está configurado como "workflow".`);
        results.pagesConfigured = true;
      }
    } else if (pagesCheck.status === 401 || pagesCheck.status === 403) {
      const msg = `Sem autorização para consultar GitHub Pages em ${owner}/${repo} (HTTP ${pagesCheck.status}): ${JSON.stringify(pagesCheck.data)}`;
      if (isPatMode) {
        console.error(`❌ ${msg}`);
        results.errors.push(msg);
      } else {
        console.log(`ℹ️ ${msg}`);
      }
    } else {
      const errMsg = `Erro ao consultar status do Pages (HTTP ${pagesCheck.status}): ${JSON.stringify(pagesCheck.data)}`;
      console.error(`❌ ${errMsg}`);
      results.errors.push(errMsg);
    }
  } catch (err) {
    results.errors.push(`Erro ao configurar GitHub Pages: ${err.message}`);
  }

  // 7. Disparar workflow deploy.yml se o Pages acabou de ser ativado ou se o último deploy falhou
  try {
    const shouldDispatch = results.pagesConfigured && (pagesJustActivated || !latestDeployRun || latestDeployRun.conclusion === 'failure');

    if (shouldDispatch) {
      console.log(`🚀 Disparando workflow deploy.yml na branch ${defaultBranch}...`);
      const dispatchRes = await ghRequest(`/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: defaultBranch
        })
      });

      if (dispatchRes.ok || dispatchRes.status === 204) {
        console.log(`✅ Workflow deploy.yml disparado com sucesso!`);
        results.deployTriggered = true;
      } else {
        console.warn(`⚠️ Aviso ao disparar deploy.yml (HTTP ${dispatchRes.status}): ${JSON.stringify(dispatchRes.data)}`);
      }
    } else if (latestDeployRun) {
      console.log(`ℹ️ Execução existente do workflow deploy.yml: status="${latestDeployRun.status}", conclusão="${latestDeployRun.conclusion}".`);
      results.deployTriggered = true;
    }
  } catch (err) {
    console.warn(`⚠️ Não foi possível verificar/disparar o workflow de deploy: ${err.message}`);
  }

  return results;
}

async function main() {
  console.log(`======================================================`);
  console.log(`🤖 AUTOMAÇÃO DE REPOSITÓRIOS GITHUB PAGES`);
  console.log(`======================================================`);

  const summary = [];

  if (USE_PAT_MODE) {
    console.log(`🔑 Modo Central ativo (PAGES_AUTOMATION_TOKEN detectado).`);
    const authenticatedUser = await getAuthenticatedUser();
    console.log(`👤 Usuário autenticado pelo token: ${authenticatedUser}`);

    const owner = TARGET_OWNER || authenticatedUser;
    console.log(`🎯 Proprietário alvo: ${owner}`);

    if (TARGET_REPO) {
      console.log(`🎯 Configurando repositório específico: "${owner}/${TARGET_REPO}"`);
      const res = await configureRepository(owner, TARGET_REPO, true);
      summary.push(res);
    } else {
      console.log(`🌐 Varredura automática de novos repositórios de "${owner}"...`);
      const candidates = await listCandidateRepositories(owner, authenticatedUser);
      console.log(`📋 Repositórios recentes encontrados: ${candidates.length}`);

      for (const repo of candidates) {
        const res = await configureRepository(owner, repo.name, true);
        summary.push(res);
      }
    }
  } else {
    console.log(`ℹ️ PAGES_AUTOMATION_TOKEN não encontrado neste repositório.`);
    console.log(`🔄 Ativando fallback automático via GITHUB_TOKEN para: ${CURRENT_REPOSITORY}`);

    const [owner, repo] = CURRENT_REPOSITORY.split('/');
    if (!owner || !repo) {
      console.error(`❌ CURRENT_REPOSITORY inválido: "${CURRENT_REPOSITORY}"`);
      process.exit(1);
    }

    const res = await configureRepository(owner, repo, false);
    summary.push(res);
  }

  console.log(`\n======================================================`);
  console.log(`📊 RESUMO DA EXECUÇÃO`);
  console.log(`======================================================`);
  for (const s of summary) {
    let statusText = 'ℹ️ PROCESSADO';
    if (s.alreadyConfigured) {
      statusText = '⚡ JÁ CONFIGURADO & ATIVO (PULADO)';
    } else if (s.pagesConfigured) {
      statusText = '✅ CONFIGURADO COM SUCESSO';
    } else if (s.errors.length > 0) {
      statusText = '❌ ATENÇÃO / FALHA';
    }

    console.log(`- ${s.repo}: ${statusText}`);
    if (s.errors.length > 0) {
      s.errors.forEach(err => console.log(`    ↳ ${err}`));
    }
  }
  console.log(`======================================================\n`);

  // No modo central PAT, falha o job se houver erros reais de configuração
  if (USE_PAT_MODE && summary.some(s => s.errors.length > 0)) {
    console.error('❌ Uma ou mais configurações falharam no modo central. Verifique os erros acima.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`💥 Erro fatal durante a execução da automação:`, err);
  process.exit(1);
});
