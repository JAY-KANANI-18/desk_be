import {
  findElseBranchConnector,
  isElseBranchConnector,
  type WorkflowBranchConnector,
} from './branch-routing.util';

describe('branch routing helpers', () => {
  it('recognizes an explicit Else connector by flag', () => {
    const connectors: WorkflowBranchConnector[] = [
      { name: 'Branch 1', data: { conditions: [{ id: 'cond-1' }] } },
      { name: 'Any label', data: { conditions: [], isElse: true } },
    ];

    expect(isElseBranchConnector(connectors[1], 1, connectors)).toBe(true);
    expect(findElseBranchConnector(connectors)).toBe(connectors[1]);
  });

  it('recognizes an explicit Else connector by name', () => {
    const connectors: WorkflowBranchConnector[] = [
      { name: 'Branch 1', data: { conditions: [] } },
      { name: 'Else', data: { conditions: [] } },
    ];

    expect(isElseBranchConnector(connectors[1], 1, connectors)).toBe(true);
    expect(findElseBranchConnector(connectors)).toBe(connectors[1]);
  });

  it('treats the legacy second empty Branch Path as fallback', () => {
    const connectors: WorkflowBranchConnector[] = [
      { name: 'Branch Path', data: { conditions: [{ id: 'cond-1' }] } },
      { name: 'Branch Path', data: { conditions: [] } },
    ];

    expect(isElseBranchConnector(connectors[1], 1, connectors)).toBe(true);
    expect(findElseBranchConnector(connectors)).toBe(connectors[1]);
  });

  it('does not hide a configured Branch Path as Else', () => {
    const connectors: WorkflowBranchConnector[] = [
      { name: 'Branch Path', data: { conditions: [] } },
      { name: 'Branch Path', data: { conditions: [{ id: 'cond-2' }] } },
    ];

    expect(isElseBranchConnector(connectors[1], 1, connectors)).toBe(false);
    expect(findElseBranchConnector(connectors)).toBeUndefined();
  });
});
