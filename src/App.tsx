import { useState, useMemo, useCallback } from 'react';
import NetworkGraph from './components/NetworkGraph';
import BipartiteGraph from './components/BipartiteGraph';
import { type NetworkData, type NetworkNode } from './services/csvParser';

interface Grant {
  recipientEIN?: string;
  recipientName?: string;
  funderEIN?: string;
  funderName?: string;
  amount: number;
  year: number;
}

function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NetworkNode | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | 'all'>(2023); // Default to 2023 instead of 'all'
  const [minLinks, setMinLinks] = useState<number>(1);
  const [rawNetworkData, setRawNetworkData] = useState<NetworkData | null>(null);
  const [showAllGrantees, setShowAllGrantees] = useState(false);
  const [showDataInfo, setShowDataInfo] = useState(false);
  const [activeTab, setActiveTab] = useState<'network' | 'bipartite'>('network');
  const [focusedGranteeId, setFocusedGranteeId] = useState<string | null>(null);

  // Bipartite filters
  const [bipartiteTopN, setBipartiteTopN] = useState<number>(50);
  const [bipartiteMinAmount, setBipartiteMinAmount] = useState<number>(0);
  const [bipartiteSearch, setBipartiteSearch] = useState<string>('');

  // Get central node info (the foundation we're visualizing)
  const centralNode = useMemo(() => {
    if (!rawNetworkData) return null;
    return rawNetworkData.nodes.find((n: any) => n.central === true) || null;
  }, [rawNetworkData]);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Load pre-filtered network data via API endpoint (avoids CORS issues)
      const networkResponse = await fetch('/api/grants-network-data');

      if (!networkResponse.ok) {
        throw new Error('Failed to load network data from server.');
      }

      const fullNetworkData = await networkResponse.json();
      setRawNetworkData(fullNetworkData);
      setLoading(false);

    } catch (err) {
      console.error('Error loading data:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  // Filter data by year only (for Bipartite view - it has its own topN filter)
  const bipartiteData = useMemo(() => {
    if (!rawNetworkData) return null;

    // Find the central node
    const centralNode = rawNetworkData.nodes.find((n: any) => n.central === true);
    if (!centralNode) return null;
    const centralNodeId = centralNode.id;

    // Filter links by year only
    let filteredLinks = rawNetworkData.links;
    if (selectedYear !== 'all') {
      filteredLinks = filteredLinks.filter((link: any) => link.year === selectedYear);
    }

    // Identify central node's grantees
    const centralGranteeIds = new Set<string>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      if (sourceId === centralNodeId) {
        const targetId = typeof link.target === 'string' ? link.target : link.target.id;
        centralGranteeIds.add(targetId);
      }
    });

    // Keep links involving central node's grantees
    filteredLinks = filteredLinks.filter((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return sourceId === centralNodeId || centralGranteeIds.has(targetId);
    });

    // Aggregate grants
    const linkMap = new Map<string, any>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      const key = `${sourceId}|${targetId}`;

      if (!linkMap.has(key)) {
        linkMap.set(key, {
          source: sourceId,
          target: targetId,
          amount: 0,
          grantCount: 0,
          year: link.year,
          grants: []
        });
      }

      const aggregated = linkMap.get(key);
      aggregated.amount += link.amount || 0;
      aggregated.grantCount += 1;
      aggregated.grants.push({
        amount: link.amount,
        year: link.year,
        recipientName: link.recipientName || '',
        recipientEIN: link.recipientEIN || ''
      });
    });

    filteredLinks = Array.from(linkMap.values());

    // Build node set
    const referencedNodeIds = new Set<string>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      referencedNodeIds.add(sourceId);
      referencedNodeIds.add(targetId);
    });

    const filteredNodes = rawNetworkData.nodes.filter((node: any) => referencedNodeIds.has(node.id));

    const normalizedLinks = filteredLinks.map((link: any) => ({
      ...link,
      source: typeof link.source === 'string' ? link.source : link.source.id,
      target: typeof link.target === 'string' ? link.target : link.target.id
    }));

    return {
      nodes: filteredNodes,
      links: normalizedLinks
    };
  }, [rawNetworkData, selectedYear]);

  // Filter data by year and minLinks - WITHOUT focus filter (for grantee list)
  const unfocusedNetworkData = useMemo(() => {
    if (!rawNetworkData) return null;

    // Find the central node (the one with central=true, regardless of its actual ID)
    const centralNode = rawNetworkData.nodes.find((n: any) => n.central === true);
    if (!centralNode) return null;
    const centralNodeId = centralNode.id;

    // Step 1: Filter links by year FIRST (if specified)
    let filteredLinks = rawNetworkData.links;
    if (selectedYear !== 'all') {
      filteredLinks = filteredLinks.filter((link: any) => link.year === selectedYear);
    }

    // Step 2: Identify central node's grantees from the YEAR-FILTERED links
    // This ensures we only show grantees that the central node funded in the selected year
    const centralGranteeIds = new Set<string>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      if (sourceId === centralNodeId) {
        const targetId = typeof link.target === 'string' ? link.target : link.target.id;
        centralGranteeIds.add(targetId);
      }
    });

    // Step 3: Only keep links that involve central node's grantees from the selected year
    // This means: central-node -> grantee OR other-funder -> central-grantee
    filteredLinks = filteredLinks.filter((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;

      // Keep if source is the central node (central -> grantee links)
      if (sourceId === centralNodeId) return true;

      // Keep if target is a central node grantee (other-funder -> central-grantee links)
      if (centralGranteeIds.has(targetId)) return true;

      return false;
    });

    // Step 3.5: Aggregate multiple grants into single links (one link per relationship)
    // Group by source-target pair and sum amounts
    const linkMap = new Map<string, any>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      const key = `${sourceId}|${targetId}`;

      if (!linkMap.has(key)) {
        linkMap.set(key, {
          source: sourceId,
          target: targetId,
          amount: 0,
          grantCount: 0,
          year: link.year,
          grants: [] // Store all individual grants for side panel
        });
      }

      const aggregated = linkMap.get(key);
      aggregated.amount += link.amount || 0;
      aggregated.grantCount += 1;
      aggregated.grants.push({
        amount: link.amount,
        year: link.year,
        recipientName: link.recipientName || '',
        recipientEIN: link.recipientEIN || ''
      });
    });

    // Convert back to array
    filteredLinks = Array.from(linkMap.values());

    // Step 4: Filter funders by minimum unique grantees (not total links)
    if (minLinks > 1) {
      // Count unique grantees per funder
      const funderGranteeCounts = new Map<string, Set<string>>();
      filteredLinks.forEach((link: any) => {
        const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
        const targetId = typeof link.target === 'string' ? link.target : link.target.id;
        const sourceNode = rawNetworkData.nodes.find((n: any) => n.id === sourceId);

        if (sourceNode?.type === 'funder') {
          if (!funderGranteeCounts.has(sourceId)) {
            funderGranteeCounts.set(sourceId, new Set());
          }
          funderGranteeCounts.get(sourceId)!.add(targetId);
        }
      });

      // Remove links from funders that don't meet threshold
      filteredLinks = filteredLinks.filter((link: any) => {
        const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
        const sourceNode = rawNetworkData.nodes.find((n: any) => n.id === sourceId);

        // Keep all non-funder links (central node and grantee links)
        if (sourceNode?.type !== 'funder') return true;

        // For funder links, check if they meet threshold (unique grantees, not total links)
        const uniqueGrantees = funderGranteeCounts.get(sourceId)?.size || 0;
        return uniqueGrantees >= minLinks;
      });
    }

    // Step 5: Build set of node IDs that are referenced in the filtered links
    const referencedNodeIds = new Set<string>();
    filteredLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      referencedNodeIds.add(sourceId);
      referencedNodeIds.add(targetId);
    });

    // Step 6: Filter nodes to only those referenced in links
    const filteredNodes = rawNetworkData.nodes.filter((node: any) => referencedNodeIds.has(node.id));

    // Step 7: Normalize links (convert source/target objects to IDs)
    const normalizedLinks = filteredLinks.map((link: any) => ({
      ...link,
      source: typeof link.source === 'string' ? link.source : link.source.id,
      target: typeof link.target === 'string' ? link.target : link.target.id
    }));

    return {
      nodes: filteredNodes,
      links: normalizedLinks
    };
  }, [rawNetworkData, selectedYear, minLinks]);

  // Apply focus filter to create final network data
  const networkData = useMemo(() => {
    if (!unfocusedNetworkData || !focusedGranteeId) return unfocusedNetworkData;

    // Filter links to only show the focused grantee
    const focusedLinks = unfocusedNetworkData.links.filter((link: any) => {
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      return targetId === focusedGranteeId;
    });

    // Build set of node IDs referenced in focused links
    const referencedNodeIds = new Set<string>();
    focusedLinks.forEach((link: any) => {
      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
      referencedNodeIds.add(sourceId);
      referencedNodeIds.add(targetId);
    });

    // Filter nodes to only those referenced in links
    const focusedNodes = unfocusedNetworkData.nodes.filter((node: any) =>
      referencedNodeIds.has(node.id)
    );

    return {
      nodes: focusedNodes,
      links: focusedLinks
    };
  }, [unfocusedNetworkData, focusedGranteeId]);

  // Calculate stats reactively
  const stats = useMemo(() => {
    if (!networkData) return { grantees: 0, funders: 0, totalLinks: 0 };

    const grantees = networkData.nodes.filter((n: any) => n.type === 'grantee').length;
    const funders = networkData.nodes.filter((n: any) => n.type === 'funder').length;

    return {
      grantees,
      funders,
      totalLinks: networkData.links.length
    };
  }, [networkData]);

  // Memoize node click handler to prevent simulation restarts
  const handleNodeClick = useCallback((node: NetworkNode | null) => {
    setSelectedNode(node);
    setShowAllGrantees(false);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Compact Header */}
      <header className="bg-white shadow-md border-b border-gray-200 flex-shrink-0">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img
              src="/hlf-logo.png"
              alt="Hidden Leaf Foundation"
              className="h-10 w-auto brightness-0"
              style={{ maxHeight: '40px' }}
            />
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                {centralNode ? `${centralNode.name} Grants Network` : 'Grants Network'}
              </h1>
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-600">
                  IRS 990 Data • Click nodes • Drag to reposition • Scroll to zoom
                </p>
                <button
                  onClick={() => setShowDataInfo(true)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                  aria-label="Data source information"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
            >
              {/* <option value="all">All Years</option> */}
              <option value="2025">2025</option>
              <option value="2024">2024</option>
              <option value="2023">2023</option>
              <option value="2022">2022</option>
            </select>

            <button
              onClick={loadData}
              disabled={loading}
              className="px-6 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg hover:from-emerald-700 hover:to-teal-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed transition-all font-medium shadow-sm hover:shadow-md text-sm"
            >
              {loading ? 'Loading...' : networkData ? 'Reload' : 'Load Data'}
            </button>

            {networkData && (
              <div className="flex gap-4 text-xs text-gray-600">
                <div>
                  <span className="font-semibold">Grantee Partners:</span> {stats.grantees}
                </div>
                <div>
                  <span className="font-semibold">Other Funders:</span> {stats.funders}
                </div>
                <div>
                  <span className="font-semibold">Links:</span> {stats.totalLinks}
                </div>
              </div>
            )}

            {/* Legend */}
            <div className="flex gap-3 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'rgb(113, 206, 126)' }}></div>
                <span className="text-gray-700">{centralNode?.name || 'Foundation'}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#ea8535' }}></div>
                <span className="text-gray-700">Grantee Partners</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#802e87' }}></div>
                <span className="text-gray-700">Other Funders</span>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="px-6 pb-3">
            <div className="p-2 bg-red-50 border border-red-200 rounded text-red-800 text-xs">
              <strong>Error:</strong> {error}
            </div>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="border-t border-gray-200">
          <div className="px-6 flex gap-1">
            <button
              onClick={() => setActiveTab('network')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'network'
                  ? 'text-emerald-600 border-emerald-600'
                  : 'text-gray-600 border-transparent hover:text-gray-900 hover:border-gray-300'
              }`}
            >
              Network Graph
            </button>
            <button
              onClick={() => setActiveTab('bipartite')}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === 'bipartite'
                  ? 'text-emerald-600 border-emerald-600'
                  : 'text-gray-600 border-transparent hover:text-gray-900 hover:border-gray-300'
              }`}
            >
              Bipartite View
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {activeTab === 'network' && (
          <div className="flex-1 flex flex-col">
            {/* Filter Panel */}
            <div className="bg-white border-b border-gray-200 px-4 py-3">
              <div className="flex items-center gap-4">
                <label htmlFor="minLinks" className="text-sm font-medium text-gray-700 whitespace-nowrap">
                  Min Funder Links:
                </label>
                <input
                  id="minLinks"
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={minLinks}
                  onChange={(e) => setMinLinks(parseInt(e.target.value))}
                  className="w-48 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
                <span className="text-sm font-semibold text-emerald-700 w-6">
                  {minLinks}
                </span>
                <span className="text-xs text-gray-600">
                  (Only show funders with at least {minLinks} grantee{minLinks > 1 ? 's' : ''})
                </span>
              </div>
            </div>

            {/* Three-column layout */}
            <div className="flex flex-1 overflow-hidden">
              {/* Left Panel: Grantee List */}
              <div className="w-64 border-r border-gray-200 bg-white p-4 overflow-y-auto">
              <h3 className="text-sm font-bold text-gray-900 mb-3">Grantee Partners</h3>
              {unfocusedNetworkData && (() => {
                const grantees = unfocusedNetworkData.nodes
                  .filter((n: any) => n.type === 'grantee')
                  .map((grantee: any) => {
                    const funderCount = unfocusedNetworkData.links.filter((l: any) => l.target === grantee.id).length;
                    const totalFunding = unfocusedNetworkData.links
                      .filter((l: any) => l.target === grantee.id)
                      .reduce((sum, l) => sum + (l.amount || 0), 0);
                    return { ...grantee, funderCount, totalFunding };
                  })
                  .sort((a, b) => b.funderCount - a.funderCount);

                return (
                  <div className="space-y-1">
                    <button
                      onClick={() => setFocusedGranteeId(null)}
                      className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                        focusedGranteeId === null
                          ? 'bg-emerald-100 text-emerald-900 font-medium'
                          : 'hover:bg-gray-100 text-gray-700'
                      }`}
                    >
                      <div className="font-medium">All Grantees</div>
                      <div className="text-[10px] text-gray-600">Full network view</div>
                    </button>
                    {grantees.map((grantee: any) => (
                      <button
                        key={grantee.id}
                        onClick={() => setFocusedGranteeId(grantee.id)}
                        className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                          focusedGranteeId === grantee.id
                            ? 'bg-emerald-100 text-emerald-900 font-medium'
                            : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <div className="font-medium truncate">{grantee.name}</div>
                        <div className="text-[10px] text-gray-600">
                          {grantee.funderCount} funder{grantee.funderCount > 1 ? 's' : ''} • ${(grantee.totalFunding / 1000).toFixed(0)}k
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Center: Network Graph */}
            <div className="flex-1 p-4">
          {loading && (
            <div className="flex items-center justify-center h-full bg-white rounded-lg shadow">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
                <p className="mt-4 text-gray-600 text-sm">Loading network data...</p>
              </div>
            </div>
          )}

          {!loading && networkData && (
            <div className="h-full bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden">
              <NetworkGraph
                data={networkData}
                width={1400}
                height={900}
                onNodeClick={handleNodeClick}
                selectedNodeId={selectedNode?.id || null}
              />
            </div>
          )}

          {!loading && !networkData && !error && (
            <div className="flex items-center justify-center h-full bg-white rounded-lg shadow">
              <p className="text-gray-600 text-sm">Click "Load Data" to visualize the grants network</p>
            </div>
          )}
        </div>

        {/* Right: IDE-Style Side Panel */}
        <div className="w-96 border-l border-gray-200 bg-white flex flex-col flex-shrink-0">
          {selectedNode ? (
            <div className="flex flex-col h-full">
              {/* Panel Header */}
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Node Details</h2>
                <button
                  onClick={() => handleNodeClick(null)}
                  className="text-gray-500 hover:text-gray-700 text-sm px-2 py-1 hover:bg-gray-100 rounded"
                >
                  ✕ Close
                </button>
              </div>

              {/* Panel Content */}
              <div className="flex-1 overflow-y-auto p-4">
                <div className="space-y-4">
                  {/* Basic Info */}
                  <div>
                    <h3 className="font-bold text-lg text-gray-900 mb-1">{selectedNode.name}</h3>
                    <div className="space-y-1 text-sm text-gray-600">
                      <p>
                        <span className="font-semibold">Type:</span>{' '}
                        <span className="capitalize">{selectedNode.type === 'grantee' ? 'Grantee Partner' : selectedNode.type}</span>
                      </p>
                      {!selectedNode.central && (
                        <p className="text-xs">
                          <span className="font-semibold">EIN:</span> {selectedNode.id}
                        </p>
                      )}

                      {/* Metadata */}
                      {selectedNode.metadata && (
                        <div className="mt-2 pt-2 border-t border-gray-200">
                          {selectedNode.metadata.city && selectedNode.metadata.state && (
                            <p className="text-xs">
                              <span className="font-semibold">Location:</span> {selectedNode.metadata.city}, {selectedNode.metadata.state}
                            </p>
                          )}
                          {selectedNode.metadata.assets && selectedNode.metadata.assets > 0 && (
                            <p className="text-xs">
                              <span className="font-semibold">Assets:</span> ${selectedNode.metadata.assets.toLocaleString()}
                            </p>
                          )}
                          {selectedNode.metadata.revenue && selectedNode.metadata.revenue > 0 && (
                            <p className="text-xs">
                              <span className="font-semibold">Revenue:</span> ${selectedNode.metadata.revenue.toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* For grantee nodes: show linked funders and all funders */}
                  {selectedNode.type === 'grantee' && selectedNode.grantsReceived && (() => {
                    // Filter grants by selected year
                    const filteredGrants = selectedNode.grantsReceived.filter((grant: Grant) =>
                      selectedYear === 'all' || grant.year === selectedYear
                    );

                    // Get set of currently visible node IDs in the network
                    const visibleNodeIds = new Set(networkData?.nodes.map((n: any) => n.id) || []);

                    // Separate into linked (visible in network) vs other funders
                    const linkedFunderGrants = filteredGrants.filter((grant: Grant) =>
                      visibleNodeIds.has(grant.funderEIN)
                    );
                    const otherFunderGrants = filteredGrants.filter((grant: Grant) =>
                      !visibleNodeIds.has(grant.funderEIN)
                    );

                    // Group grants by funder (deduplicate)
                    const groupGrantsByFunder = (grants: Grant[]) => {
                      const funderMap = new Map<string, { id: string; name: string; grants: Grant[] }>();
                      grants.forEach((grant) => {
                        const key = grant.funderEIN || grant.funderName || 'unknown';

                        if (!funderMap.has(key)) {
                          funderMap.set(key, {
                            id: grant.funderEIN || '',
                            name: grant.funderName || 'Unknown Funder',
                            grants: []
                          });
                        }
                        funderMap.get(key)!.grants.push(grant);
                      });
                      return Array.from(funderMap.values()).sort((a, b) => {
                        const totalA = a.grants.reduce((sum, g) => sum + g.amount, 0);
                        const totalB = b.grants.reduce((sum, g) => sum + g.amount, 0);
                        return totalB - totalA;
                      });
                    };

                    const groupedLinkedFunders = groupGrantsByFunder(linkedFunderGrants);
                    const groupedOtherFunders = groupGrantsByFunder(otherFunderGrants);

                    return (
                      <div className="border-t border-gray-200 pt-4">
                        {/* Linked Funders - clickable */}
                        {groupedLinkedFunders.length > 0 && (
                          <>
                            <h4 className="font-semibold text-sm text-gray-900 mb-2">
                              Linked Funders ({groupedLinkedFunders.length})
                            </h4>
                            <p className="text-xs text-gray-600 mb-3">
                              Funders currently visible in the network
                            </p>
                            <div className="space-y-3 mb-4">
                              {groupedLinkedFunders.map((funder, idx) => {
                                const funderNode = networkData?.nodes.find((n: any) => n.id === funder.id);
                                const totalAmount = funder.grants.reduce((sum, g) => sum + g.amount, 0);

                                return (
                                  <div
                                    key={`${funder.id}-${idx}`}
                                    className="bg-blue-50 p-3 rounded border border-blue-200 cursor-pointer hover:bg-blue-100 transition-colors"
                                    onClick={() => funderNode && handleNodeClick(funderNode)}
                                  >
                                    <div className="font-medium text-sm text-gray-900 mb-1">{funder.name}</div>
                                    <div className="text-xs text-gray-700 mb-2">
                                      Total: ${totalAmount.toLocaleString()} ({funder.grants.length} grant{funder.grants.length > 1 ? 's' : ''})
                                    </div>
                                    {funder.grants.map((grant, gIdx) => (
                                      <div key={gIdx} className="text-xs text-gray-600 ml-2">
                                        • ${grant.amount.toLocaleString()} • {grant.year}
                                      </div>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}

                        {/* All Other Funders - collapsible, not clickable */}
                        {groupedOtherFunders.length > 0 && (
                          <>
                            <button
                              onClick={() => setShowAllGrantees(!showAllGrantees)}
                              className="w-full flex items-center justify-between px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 font-medium transition-colors mb-2"
                            >
                              <span>All Other Funders ({groupedOtherFunders.length})</span>
                              <svg
                                className={`w-4 h-4 transition-transform ${showAllGrantees ? 'rotate-180' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {showAllGrantees && (
                              <div className="space-y-3">
                                {groupedOtherFunders.map((funder, idx) => {
                                  const totalAmount = funder.grants.reduce((sum, g) => sum + g.amount, 0);

                                  return (
                                    <div key={`${funder.id}-${idx}`} className="bg-gray-50 p-3 rounded border border-gray-200">
                                      <div className="font-medium text-sm text-gray-900 mb-1">{funder.name}</div>
                                      <div className="text-xs text-gray-700 mb-2">
                                        Total: ${totalAmount.toLocaleString()} ({funder.grants.length} grant{funder.grants.length > 1 ? 's' : ''})
                                      </div>
                                      {funder.grants.map((grant, gIdx) => (
                                        <div key={gIdx} className="text-xs text-gray-600 ml-2">
                                          • ${grant.amount.toLocaleString()} • {grant.year}
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}

                        {linkedFunderGrants.length === 0 && otherFunderGrants.length === 0 && (
                          <p className="text-sm text-gray-500">No funders found</p>
                        )}
                      </div>
                    );
                  })()}

                  {/* For funder nodes: show overlapping grantees first */}
                  {selectedNode.type === 'funder' && selectedNode.grantsGiven && (() => {
                    // Get central node's grantee IDs and names
                    const centralGranteeIds = new Set(
                      networkData?.nodes
                        .filter((n: any) => n.type === 'grantee')
                        .map((n: any) => n.id) || []
                    );

                    // Build name-to-ID map for fuzzy matching
                    const normalizeOrgName = (name: string) => {
                      return name
                        .toLowerCase()
                        .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|foundation|fund|trust|the|a|an)\b/g, '')
                        .replace(/[^a-z0-9]+/g, '')
                        .trim();
                    };

                    const nameToIdMap = new Map<string, string>();
                    networkData?.nodes
                      .filter((n: any) => n.type === 'grantee')
                      .forEach((n: any) => {
                        nameToIdMap.set(normalizeOrgName(n.name), n.id);
                      });

                    // Helper to find node ID from a grant's recipient info
                    const findRecipientId = (grant: Grant): string | null => {
                      // Try direct EIN match first
                      if (grant.recipientEIN && grant.recipientEIN !== '' && !grant.recipientEIN.startsWith('unknown_')) {
                        if (centralGranteeIds.has(grant.recipientEIN)) {
                          return grant.recipientEIN;
                        }
                      }

                      // Try name matching (handles consolidation)
                      if (grant.recipientName) {
                        const normalized = normalizeOrgName(grant.recipientName);
                        const matchedId = nameToIdMap.get(normalized);
                        if (matchedId) {
                          return matchedId;
                        }

                        // Fallback to placeholder ID
                        const placeholderId = `no_ein_${normalized}`;
                        if (centralGranteeIds.has(placeholderId)) {
                          return placeholderId;
                        }
                      }

                      return null;
                    };

                    // Separate grants into overlapping and non-overlapping, filtered by year
                    const sortedGrants = [...selectedNode.grantsGiven].sort((a, b) => b.amount - a.amount);
                    const overlappingGrants = sortedGrants.filter((grant: Grant) => {
                      if (selectedYear !== 'all' && grant.year !== selectedYear) return false;
                      const recipientId = findRecipientId(grant);
                      return recipientId !== null;
                    });
                    const nonOverlappingGrants = sortedGrants.filter((grant: Grant) => {
                      if (selectedYear !== 'all' && grant.year !== selectedYear) return false;
                      const recipientId = findRecipientId(grant);
                      return recipientId === null;
                    });

                    // Group grants by organization (deduplicate)
                    const groupGrantsByOrg = (grants: Grant[]) => {
                      const orgMap = new Map<string, { id: string; name: string; grants: Grant[] }>();
                      grants.forEach((grant) => {
                        const recipientId = findRecipientId(grant);
                        const key = recipientId || grant.recipientEIN || grant.recipientName || 'unknown';

                        if (!orgMap.has(key)) {
                          orgMap.set(key, {
                            id: recipientId || '',
                            name: grant.recipientName || 'Unknown Recipient',
                            grants: []
                          });
                        }
                        orgMap.get(key)!.grants.push(grant);
                      });
                      return Array.from(orgMap.values()).sort((a, b) => {
                        const totalA = a.grants.reduce((sum, g) => sum + g.amount, 0);
                        const totalB = b.grants.reduce((sum, g) => sum + g.amount, 0);
                        return totalB - totalA;
                      });
                    };

                    const groupedOverlapping = groupGrantsByOrg(overlappingGrants);
                    const groupedNonOverlapping = groupGrantsByOrg(nonOverlappingGrants);

                    const centralName = centralNode?.name || 'Central Foundation';

                    return (
                      <div className="border-t border-gray-200 pt-4">
                        {groupedOverlapping.length > 0 && (
                          <>
                            <h4 className="font-semibold text-sm text-gray-900 mb-2">
                              Shared Grantees with {centralName} ({groupedOverlapping.length})
                            </h4>
                            <p className="text-xs text-gray-600 mb-3">
                              Organizations that receive funding from both this funder and {centralName}
                            </p>
                            <div className="space-y-3 mb-4">
                              {groupedOverlapping.map((org, idx) => {
                                const recipientNode = networkData?.nodes.find((n: any) => n.id === org.id);
                                const totalAmount = org.grants.reduce((sum, g) => sum + g.amount, 0);

                                return (
                                  <div
                                    key={`${org.id}-${idx}`}
                                    onClick={() => recipientNode && handleNodeClick(recipientNode)}
                                    className="bg-emerald-50 p-3 rounded border border-emerald-200 cursor-pointer hover:bg-emerald-100 hover:border-emerald-300 transition-colors"
                                  >
                                    <div className="font-medium text-sm text-gray-900 mb-1">{org.name}</div>
                                    <div className="text-xs text-gray-700 mb-2">
                                      Total: ${totalAmount.toLocaleString()} ({org.grants.length} grant{org.grants.length > 1 ? 's' : ''})
                                    </div>
                                    {org.grants.map((grant, gIdx) => (
                                      <div key={gIdx} className="text-xs text-gray-600 ml-2">
                                        • ${grant.amount.toLocaleString()} • {grant.year}
                                      </div>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}

                        {groupedNonOverlapping.length > 0 && (
                          <>
                            <button
                              onClick={() => setShowAllGrantees(!showAllGrantees)}
                              className="w-full flex items-center justify-between px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 font-medium transition-colors mb-2"
                            >
                              <span>All Other Grantees ({groupedNonOverlapping.length})</span>
                              <svg
                                className={`w-4 h-4 transition-transform ${showAllGrantees ? 'rotate-180' : ''}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {showAllGrantees && (
                              <div className="space-y-3">
                                {groupedNonOverlapping.map((org, idx) => {
                                  const totalAmount = org.grants.reduce((sum, g) => sum + g.amount, 0);

                                  return (
                                    <div key={`${org.id}-${idx}`} className="bg-gray-50 p-3 rounded border border-gray-200">
                                      <div className="font-medium text-sm text-gray-900 mb-1">{org.name}</div>
                                      <div className="text-xs text-gray-700 mb-2">
                                        Total: ${totalAmount.toLocaleString()} ({org.grants.length} grant{org.grants.length > 1 ? 's' : ''})
                                      </div>
                                      {org.grants.map((grant, gIdx) => (
                                        <div key={gIdx} className="text-xs text-gray-600 ml-2">
                                          • ${grant.amount.toLocaleString()} • {grant.year}
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}

                        {groupedOverlapping.length === 0 && groupedNonOverlapping.length === 0 && (
                          <p className="text-sm text-gray-500">No grantees found</p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full p-8 text-center">
              <div>
                <div className="text-gray-400 mb-2">
                  <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">Click a node to view details</p>
              </div>
            </div>
          )}
        </div>
            </div>
          </div>
        )}

        {activeTab === 'bipartite' && (
          <div className="flex-1 p-4 flex flex-col">
            <div className="bg-white rounded-lg shadow mb-4 p-4">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Bipartite View Filters</h2>
              <div className="grid grid-cols-3 gap-4">
                {/* Top N Funders */}
                <div>
                  <label htmlFor="bipartiteTopN" className="block text-sm font-medium text-gray-700 mb-2">
                    Top N Funders: {bipartiteTopN}
                  </label>
                  <input
                    id="bipartiteTopN"
                    type="range"
                    min="10"
                    max="200"
                    step="10"
                    value={bipartiteTopN}
                    onChange={(e) => setBipartiteTopN(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>10</span>
                    <span>200</span>
                  </div>
                </div>

                {/* Min Amount */}
                <div>
                  <label htmlFor="bipartiteMinAmount" className="block text-sm font-medium text-gray-700 mb-2">
                    Min Grant Amount
                  </label>
                  <input
                    id="bipartiteMinAmount"
                    type="number"
                    min="0"
                    step="1000"
                    value={bipartiteMinAmount}
                    onChange={(e) => setBipartiteMinAmount(parseInt(e.target.value) || 0)}
                    placeholder="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Search */}
                <div>
                  <label htmlFor="bipartiteSearch" className="block text-sm font-medium text-gray-700 mb-2">
                    Search Organizations
                  </label>
                  <input
                    id="bipartiteSearch"
                    type="text"
                    value={bipartiteSearch}
                    onChange={(e) => setBipartiteSearch(e.target.value)}
                    placeholder="Filter by name..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>

            <div className="flex-1 bg-white rounded-lg shadow overflow-hidden">
              {bipartiteData ? (
                <BipartiteGraph
                  data={bipartiteData}
                  width={1400}
                  height={800}
                  topN={bipartiteTopN}
                  minAmount={bipartiteMinAmount}
                  searchQuery={bipartiteSearch}
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-gray-600 text-sm">Load data to view bipartite graph</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Data Source Info Modal */}
      {showDataInfo && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{
            zIndex: 9999,
            backgroundColor: 'rgba(0, 0, 0, 0.6)'
          }}
          onClick={() => setShowDataInfo(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <h2 className="text-xl font-bold text-gray-900">Data Sources</h2>
                <button
                  onClick={() => setShowDataInfo(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                    <svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/>
                      <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd"/>
                    </svg>
                    IRS Form 990-PF (Private Foundation Returns)
                  </h3>
                  <p className="text-sm text-gray-700 mb-2">
                    Foundation grant data including who gave grants to whom and grant amounts.
                  </p>
                  <ul className="text-xs text-gray-600 list-disc list-inside space-y-1 ml-4">
                    <li>Source: <a href="https://apps.irs.gov/pub/epostcard/990/xml/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">IRS monthly XML files</a></li>
                    <li>Updated monthly by the IRS</li>
                    <li>Contains grant relationships and amounts</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
                    <svg className="w-5 h-5 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/>
                    </svg>
                    IRS Form 990 (Public Charity Returns)
                  </h3>
                  <p className="text-sm text-gray-700 mb-2">
                    Organization metadata including financial information and location.
                  </p>
                  <ul className="text-xs text-gray-600 list-disc list-inside space-y-1 ml-4">
                    <li>Same source as Form 990-PF (IRS monthly XMLs)</li>
                    <li>Provides assets, revenue, and address for grantee organizations</li>
                    <li>Consolidated by organization name to merge entries</li>
                  </ul>
                </div>

                <div className="border-t border-gray-200 pt-4 mt-4">
                  <h3 className="font-semibold text-gray-900 mb-2">How We Process the Data</h3>
                  <ol className="text-xs text-gray-700 list-decimal list-inside space-y-2 ml-2">
                    <li><strong>Download:</strong> Fetch monthly IRS XML files (3 months in parallel)</li>
                    <li><strong>Extract:</strong> Parse Form 990-PF for grants and Form 990 for org metadata</li>
                    <li><strong>Consolidate:</strong> Merge organizations by name to link grants with metadata</li>
                    <li><strong>Build Network:</strong> Create bidirectional dataset tracking who funded whom</li>
                    <li><strong>Filter:</strong> Extract HLF's network plus other funders of the same grantees</li>
                  </ol>
                </div>

                <div className="bg-gray-50 p-4 rounded border border-gray-200">
                  <p className="text-xs text-gray-600">
                    <strong>Note:</strong> This visualization shows organizations that filed IRS Form 990 or 990-PF.
                    Organizations without recent filings may not appear. Data is updated when IRS releases new monthly files.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
