export interface WorkflowBranchConnector {
  name?: string;
  data?: {
    conditions?: unknown[];
    isElse?: boolean;
  };
}

function normalizeConnectorName(name: string | undefined) {
  return (name ?? '').trim().toLowerCase();
}

export function isElseBranchConnector<T extends WorkflowBranchConnector>(
  connector: T,
  index?: number,
  connectors?: T[],
) {
  const name = normalizeConnectorName(connector.name);

  if (connector.data?.isElse === true || name === 'else') {
    return true;
  }

  const isLegacyDefaultBranchPath =
    connectors &&
    typeof index === 'number' &&
    connectors.length > 1 &&
    index === connectors.length - 1 &&
    name === 'branch path' &&
    (connector.data?.conditions?.length ?? 0) === 0;

  return Boolean(isLegacyDefaultBranchPath);
}

export function findElseBranchConnector<T extends WorkflowBranchConnector>(
  connectors: T[],
) {
  return connectors.find((connector, index) =>
    isElseBranchConnector(connector, index, connectors),
  );
}
