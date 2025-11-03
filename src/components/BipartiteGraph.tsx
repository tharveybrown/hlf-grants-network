import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { type NetworkData } from '../services/csvParser';

interface BipartiteGraphProps {
  data: NetworkData;
  width?: number;
  height?: number;
  topN?: number;
  minAmount?: number;
  searchQuery?: string;
}

export default function BipartiteGraph({
  data,
  width = 1400,
  height = 800,
  topN = 50,
  minAmount = 0,
  searchQuery = ''
}: BipartiteGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;

    // Clear previous
    d3.select(svgRef.current).selectAll('*').remove();

    // Find central node
    const centralNode = data.nodes.find((n: any) => n.central);
    if (!centralNode) return;

    // Filter and prepare data
    let links = data.links.map((l: any) => ({
      source: typeof l.source === 'string' ? l.source : l.source.id,
      target: typeof l.target === 'string' ? l.target : l.target.id,
      value: l.amount || 0,
      grantCount: l.grantCount || 1,
      grants: l.grants || []
    }));

    // Apply minAmount filter
    if (minAmount > 0) {
      links = links.filter(l => l.value >= minAmount);
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchingNodeIds = new Set(
        data.nodes
          .filter((n: any) => n.name.toLowerCase().includes(query))
          .map((n: any) => n.id)
      );
      links = links.filter(l => matchingNodeIds.has(l.source) || matchingNodeIds.has(l.target));
    }

    // Get top N funders by total funding
    const funderTotals = new Map<string, number>();
    links.forEach(link => {
      const node = data.nodes.find((n: any) => n.id === link.source);
      if (node && node.type === 'funder' && !node.central) {
        funderTotals.set(link.source, (funderTotals.get(link.source) || 0) + link.value);
      }
    });

    const topFunderIds = new Set(
      Array.from(funderTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([id]) => id)
    );

    // Filter links to only include top funders and central node
    links = links.filter(link => {
      const sourceNode = data.nodes.find((n: any) => n.id === link.source);
      return sourceNode?.central || topFunderIds.has(link.source);
    });

    // Build node set from filtered links
    const nodeIds = new Set<string>();
    links.forEach(link => {
      nodeIds.add(link.source);
      nodeIds.add(link.target);
    });

    // Separate nodes into funders and grantees
    const funders = data.nodes
      .filter((n: any) => nodeIds.has(n.id) && n.type === 'funder')
      .sort((a: any, b: any) => {
        // Central node at top
        if (a.central) return -1;
        if (b.central) return 1;
        // Sort by total funding
        const aTotal = funderTotals.get(a.id) || 0;
        const bTotal = funderTotals.get(b.id) || 0;
        return bTotal - aTotal;
      });

    const grantees = data.nodes
      .filter((n: any) => nodeIds.has(n.id) && n.type === 'grantee')
      .sort((a: any, b: any) => {
        // Sort by total received
        const aTotal = links.filter(l => l.target === a.id).reduce((sum, l) => sum + l.value, 0);
        const bTotal = links.filter(l => l.target === b.id).reduce((sum, l) => sum + l.value, 0);
        return bTotal - aTotal;
      });

    // Layout parameters
    const margin = { top: 50, right: 150, bottom: 50, left: 150 };
    const innerHeight = height - margin.top - margin.bottom;

    const funderX = margin.left;
    const granteeX = width - margin.right;

    // Position nodes
    const funderSpacing = innerHeight / Math.max(funders.length, 1);
    const granteeSpacing = innerHeight / Math.max(grantees.length, 1);

    const funderPositions = new Map(
      funders.map((f: any, i) => [f.id, margin.top + i * funderSpacing + funderSpacing / 2])
    );

    const granteePositions = new Map(
      grantees.map((g: any, i) => [g.id, margin.top + i * granteeSpacing + granteeSpacing / 2])
    );

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', [0, 0, width, height]);

    // Add title
    svg.append('text')
      .attr('x', width / 2)
      .attr('y', 25)
      .attr('text-anchor', 'middle')
      .attr('font-size', 16)
      .attr('font-weight', 'bold')
      .attr('fill', '#1f2937')
      .text('Grant Flow: Funders → Grantees');

    // Add column labels
    svg.append('text')
      .attr('x', funderX)
      .attr('y', 25)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .attr('font-weight', 'bold')
      .attr('fill', '#802e87')
      .text('FUNDERS');

    svg.append('text')
      .attr('x', granteeX)
      .attr('y', 25)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .attr('font-weight', 'bold')
      .attr('fill', '#ea8535')
      .text('GRANTEES');

    // Calculate stroke width scale based on link values
    const maxLinkValue = Math.max(...links.map(l => l.value));
    const minLinkValue = Math.min(...links.map(l => l.value));
    const strokeScale = d3.scaleLinear()
      .domain([minLinkValue, maxLinkValue])
      .range([1, 15]); // Min and max stroke widths

    // Draw links
    const linkGroup = svg.append('g').attr('class', 'links');

    links.forEach((link) => {
      const sourceY = funderPositions.get(link.source);
      const targetY = granteePositions.get(link.target);
      if (!sourceY || !targetY) return;

      const isHovered = hoveredLink === `${link.source}-${link.target}`;
      const isNodeSelected = selectedNode === link.source || selectedNode === link.target;
      const shouldHighlight = isHovered || isNodeSelected;

      const sourceNode = data.nodes.find((n: any) => n.id === link.source);
      const baseStrokeWidth = strokeScale(link.value);

      // Create curved path for smoother appearance
      const midX = (funderX + granteeX) / 2;
      const path = d3.path();
      path.moveTo(funderX, sourceY);
      path.bezierCurveTo(
        midX, sourceY,     // Control point 1
        midX, targetY,     // Control point 2
        granteeX, targetY  // End point
      );

      linkGroup.append('path')
        .attr('d', path.toString())
        .attr('fill', 'none')
        .attr('stroke', sourceNode?.central ? 'rgb(113, 206, 126)' : '#802e87')
        .attr('stroke-width', shouldHighlight ? baseStrokeWidth + 2 : baseStrokeWidth)
        .attr('stroke-opacity', shouldHighlight ? 0.7 : 0.4)
        .attr('class', 'link')
        .style('cursor', 'pointer')
        .on('mouseenter', function() {
          setHoveredLink(`${link.source}-${link.target}`);
          d3.select(this)
            .attr('stroke-opacity', 0.7)
            .attr('stroke-width', baseStrokeWidth + 2)
            .raise();
        })
        .on('mouseleave', function() {
          setHoveredLink(null);
          if (!isNodeSelected) {
            d3.select(this)
              .attr('stroke-opacity', 0.4)
              .attr('stroke-width', baseStrokeWidth);
          }
        })
        .append('title')
        .text(() => {
          const sourceName = data.nodes.find((n: any) => n.id === link.source)?.name;
          const targetName = data.nodes.find((n: any) => n.id === link.target)?.name;
          return `${sourceName} → ${targetName}\n$${link.value.toLocaleString()}\n${link.grantCount} grant${link.grantCount > 1 ? 's' : ''}`;
        });

      // Add amount label on hover
      if (isHovered) {
        linkGroup.append('text')
          .attr('x', midX)
          .attr('y', (sourceY + targetY) / 2 - 5)
          .attr('text-anchor', 'middle')
          .attr('font-size', 11)
          .attr('fill', '#1f2937')
          .attr('font-weight', 'bold')
          .attr('class', 'amount-label')
          .style('pointer-events', 'none')
          .text(`$${(link.value / 1000).toFixed(0)}k`);
      }
    });

    // Draw funder nodes
    const funderGroup = svg.append('g').attr('class', 'funders');

    funders.forEach((funder: any) => {
      const y = funderPositions.get(funder.id);
      if (!y) return;

      const isCentral = funder.central;
      const isSelected = selectedNode === funder.id;
      const funderTotal = funderTotals.get(funder.id) || 0;

      funderGroup.append('circle')
        .attr('cx', funderX)
        .attr('cy', y)
        .attr('r', isCentral ? 10 : 6)
        .attr('fill', isCentral ? 'rgb(113, 206, 126)' : '#802e87')
        .attr('stroke', '#fff')
        .attr('stroke-width', isSelected ? 3 : 2)
        .style('cursor', 'pointer')
        .on('click', function() {
          setSelectedNode(selectedNode === funder.id ? null : funder.id);
        })
        .append('title')
        .text(`${funder.name}\n$${funderTotal.toLocaleString()} total`);

      funderGroup.append('text')
        .attr('x', funderX - 15)
        .attr('y', y)
        .attr('dy', '0.35em')
        .attr('text-anchor', 'end')
        .attr('font-size', isCentral ? 12 : 10)
        .attr('font-weight', isCentral ? 'bold' : 'normal')
        .attr('fill', '#1f2937')
        .style('cursor', 'pointer')
        .text(funder.name.length > 30 ? funder.name.substring(0, 27) + '...' : funder.name)
        .on('click', function() {
          setSelectedNode(selectedNode === funder.id ? null : funder.id);
        })
        .append('title')
        .text(funder.name);
    });

    // Draw grantee nodes
    const granteeGroup = svg.append('g').attr('class', 'grantees');

    grantees.forEach((grantee: any) => {
      const y = granteePositions.get(grantee.id);
      if (!y) return;

      const isSelected = selectedNode === grantee.id;
      const granteeTotal = links.filter(l => l.target === grantee.id).reduce((sum, l) => sum + l.value, 0);

      granteeGroup.append('circle')
        .attr('cx', granteeX)
        .attr('cy', y)
        .attr('r', 6)
        .attr('fill', '#ea8535')
        .attr('stroke', '#fff')
        .attr('stroke-width', isSelected ? 3 : 2)
        .style('cursor', 'pointer')
        .on('click', function() {
          setSelectedNode(selectedNode === grantee.id ? null : grantee.id);
        })
        .append('title')
        .text(`${grantee.name}\n$${granteeTotal.toLocaleString()} received`);

      granteeGroup.append('text')
        .attr('x', granteeX + 15)
        .attr('y', y)
        .attr('dy', '0.35em')
        .attr('text-anchor', 'start')
        .attr('font-size', 10)
        .attr('fill', '#1f2937')
        .style('cursor', 'pointer')
        .text(grantee.name.length > 30 ? grantee.name.substring(0, 27) + '...' : grantee.name)
        .on('click', function() {
          setSelectedNode(selectedNode === grantee.id ? null : grantee.id);
        })
        .append('title')
        .text(grantee.name);
    });

  }, [data, width, height, topN, minAmount, searchQuery, hoveredLink, selectedNode]);

  return (
    <div className="relative w-full h-full">
      <svg ref={svgRef} className="w-full h-full" />
      {selectedNode && (
        <div className="absolute top-4 right-4 bg-white p-3 rounded-lg shadow-lg border border-gray-200 max-w-xs">
          <div className="flex items-start justify-between mb-2">
            <h4 className="font-semibold text-sm text-gray-900">
              {data.nodes.find((n: any) => n.id === selectedNode)?.name}
            </h4>
            <button
              onClick={() => setSelectedNode(null)}
              className="text-gray-400 hover:text-gray-600 ml-2"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-gray-600">
            Click another node or the X to deselect
          </p>
        </div>
      )}
    </div>
  );
}
