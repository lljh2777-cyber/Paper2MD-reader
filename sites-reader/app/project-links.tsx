export const PROJECT_REPOSITORY_URL = "https://github.com/lljh2777-cyber/Paper2MD-reader";
export const PROJECT_ISSUES_URL = `${PROJECT_REPOSITORY_URL}/issues`;
export const MINERU_PROJECT_URL = "https://github.com/opendatalab/MinerU";
export const MINERU_API_DOCS_URL = "https://mineru.net/apiManage/docs";
export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/bnbkbfepjoaidicdjcdmklofhnaleamm";

interface ProjectLinksProps {
  includeDemo?: boolean;
}

export function ProjectLinks({ includeDemo = false }: ProjectLinksProps) {
  return (
    <nav className="project-links" aria-label="项目与技术来源">
      {includeDemo ? <a href="/demo/debyecalculator">真实演示</a> : null}
      <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noreferrer">Chrome 扩展</a>
      <a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub 项目</a>
      <a href={PROJECT_ISSUES_URL} target="_blank" rel="noreferrer">反馈问题</a>
      <a href={MINERU_PROJECT_URL} target="_blank" rel="noreferrer">MinerU 官方项目</a>
      <a href="/privacy">隐私政策</a>
    </nav>
  );
}
