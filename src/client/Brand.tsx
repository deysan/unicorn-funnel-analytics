export function Brand({ report = false }: { report?: boolean }) {
  return (
    <header className="mast">
      <span className="wordmark">unicorn<span aria-hidden="true">.</span></span>
      <span className="mast-label">
        {report ? 'Аналітика воронки' : 'Знайомства починаються з вибору'}
      </span>
      <span className="demo-label">Демо</span>
    </header>
  );
}
