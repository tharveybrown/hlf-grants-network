import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { type NetworkData, type NetworkNode, type NetworkLink } from '../services/csvParser';

interface NetworkGraphProps {
  data: NetworkData;
  width?: number;
  height?: number;
  onNodeClick?: (node: NetworkNode | null) => void;
  selectedNodeId?: string | null;
}

interface SimulationNode extends NetworkNode, d3.SimulationNodeDatum {}
interface SimulationLink extends Omit<NetworkLink, 'source' | 'target'> {
  source: SimulationNode | string;
  target: SimulationNode | string;
}

export default function NetworkGraph({ data, width = 1200, height = 800, onNodeClick, selectedNodeId }: NetworkGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const initializedRef = useRef(false);
  const nodesRef = useRef<any>(null);
  const onNodeClickRef = useRef(onNodeClick);

  // Update ref when callback changes
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);

    // Initialize container and zoom ONCE on first render
    if (!initializedRef.current) {
      initializedRef.current = true;

      svg.attr('width', width)
        .attr('height', height)
        .attr('viewBox', [0, 0, width, height]);

      const g = svg.append('g');
      gRef.current = g;

      const zoom = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      svg.call(zoom);

      // Set initial zoom to be more zoomed out (0.4x scale) centered on the graph
      const initialTransform = d3.zoomIdentity
        .translate(width * 0.3, height * 0.3)
        .scale(0.4);
      svg.call(zoom.transform, initialTransform);

      // Add defs for arrow markers
      svg.append('defs').selectAll('marker')
        .data(['funder', 'grantee', 'central'])
        .join('marker')
        .attr('id', d => `arrow-${d}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 15)
        .attr('refY', 0)
        .attr('markerWidth', 4)
        .attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path')
        .attr('fill', d => {
          if (d === 'funder') return '#802e87'; // Purple for other funders
          if (d === 'central') return 'rgb(113, 206, 126)'; // Green for central foundation
          return '#ea8535'; // Orange for grantees
        })
        .attr('d', 'M0,-5L10,0L0,5');

      // Click on background to deselect - set up once, use ref to avoid dependency
      svg.on('click', () => onNodeClickRef.current?.(null));
    }

    const g = gRef.current!;

    // Clear previous graph elements (but keep g container for zoom)
    g.selectAll('*').remove();

    // Create fresh simulation with improved layout
    // Radial layout: Central node in center, grantees in inner ring, other funders in outer ring
    const simulation = d3.forceSimulation<SimulationNode>(data.nodes as SimulationNode[])
      .force('link', d3.forceLink<SimulationNode, SimulationLink>(data.links as SimulationLink[])
        .id((d) => d.id)
        .distance(d => {
          const sourceId = typeof d.source === 'object' ? d.source.id : d.source;
          const targetId = typeof d.target === 'object' ? d.target.id : d.target;
          const sourceNode = data.nodes.find(n => n.id === sourceId) as SimulationNode;
          const targetNode = data.nodes.find(n => n.id === targetId) as SimulationNode;

          // Central node connections
          if (sourceNode?.central || targetNode?.central) return 180;
          // Funder to grantee - push further apart
          if (sourceNode?.type === 'funder' && targetNode?.type === 'grantee') return 420;
          return 360;
        })
        .strength(0.55))
      .force('charge', d3.forceManyBody()
        .strength((d) => {
          const node = d as SimulationNode;
          if (node.central) return -1300; // Central funder has strongest repulsion
          if (node.type === 'grantee') return -650;
          return -550; // Other funders
        }))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide()
        .radius((d) => {
          const node = d as SimulationNode;
          if (node.central) return 65; // Central funder
          if (node.type === 'grantee') return 55;
          return 50; // Other funders
        })
        .strength(1)
        .iterations(2)) // Multiple iterations for better collision resolution
      .force('radial', d3.forceRadial<SimulationNode>(
        d => {
          if (d.central) return 0; // Central funder at center
          if (d.type === 'grantee') return 300; // Push grantees further out
          return 650; // Push other funders much further out
        },
        width / 2,
        height / 2
      ).strength(0.6)) // Stronger radial force

    // Group links by node pairs and assign linknum for curved paths
    // This prevents multiple edges between same nodes from overlapping
    interface LinkWithNum extends SimulationLink {
      linknum?: number;
      size?: number;
    }

    const linksWithNum = data.links as LinkWithNum[];
    const linkGroup: { [key: string]: LinkWithNum[] } = {};

    // Group links by node pairs (use consistent key regardless of direction)
    linksWithNum.forEach((link) => {
      const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
      const targetId = typeof link.target === 'object' ? link.target.id : link.target;
      const key = sourceId < targetId ? `${sourceId}:${targetId}` : `${targetId}:${sourceId}`;

      if (!linkGroup[key]) {
        linkGroup[key] = [];
      }
      linkGroup[key].push(link);
    });

    // Assign linknum to each link in a group for curved paths
    Object.values(linkGroup).forEach((group) => {
      const linksA: LinkWithNum[] = [];
      const linksB: LinkWithNum[] = [];

      group.forEach((link) => {
        link.size = group.length;
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;

        // Divide by direction for upper/lower arcs
        if (sourceId < targetId) {
          linksA.push(link);
        } else {
          linksB.push(link);
        }
      });

      // Assign positive linknum to one direction, negative to other
      let startLinkANumber = 1;
      linksA.forEach((link) => {
        link.linknum = startLinkANumber++;
      });

      let startLinkBNumber = -1;
      linksB.forEach((link) => {
        link.linknum = startLinkBNumber--;
      });
    });

    // Create links using paths for curved edges
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('path')
      .data(linksWithNum)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke', d => {
        const sourceId = typeof d.source === 'string' ? d.source : (d.source as SimulationNode).id;
        const sourceNode = data.nodes.find(n => n.id === sourceId);
        if (sourceNode?.central) return 'rgb(113, 206, 126)'; // Green for central foundation
        return sourceNode?.type === 'funder' ? '#802e87' : '#ea8535'; // Purple for funders, orange for grantees
      })
      .attr('stroke-opacity', d => {
        const sourceId = typeof d.source === 'string' ? d.source : (d.source as SimulationNode).id;
        const sourceNode = data.nodes.find(n => n.id === sourceId);
        return sourceNode?.central ? 0.6 : 0.3;
      })
      .attr('stroke-width', d => {
        const sourceId = typeof d.source === 'string' ? d.source : (d.source as SimulationNode).id;
        const sourceNode = data.nodes.find(n => n.id === sourceId);
        return sourceNode?.central ? 2.5 : 1.5;
      })
      .attr('marker-end', d => {
        const sourceId = typeof d.source === 'string' ? d.source : (d.source as SimulationNode).id;
        const sourceNode = data.nodes.find(n => n.id === sourceId);
        if (sourceNode?.central) return 'url(#arrow-central)'; // Arrow for central foundation
        return `url(#arrow-${sourceNode?.type === 'funder' ? 'funder' : 'grantee'})`;
      });

    // Create link labels (hidden by default)
    const linkLabel = g.append('g')
      .attr('class', 'link-labels')
      .selectAll('text')
      .data(data.links)
      .join('text')
      .attr('font-size', 10)
      .attr('fill', '#666')
      .attr('text-anchor', 'middle')
      .attr('opacity', 0) // Hidden
      .text(d => `$${(d.amount / 1000).toFixed(0)}k`);

    // Drag functions
    function dragstarted(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    // Create nodes
    const node = g.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(data.nodes as SimulationNode[])
      .join('g')
      // @ts-expect-error - D3 drag types with generic selections can have complex inference issues
      .call(d3.drag<SVGGElement, SimulationNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended));

    // Store node reference for selection highlighting
    nodesRef.current = node;

    // Add circles to nodes
    node.append('circle')
      .attr('r', d => {
        if (d.central) return 22; // Larger central funder node
        if (d.type === 'funder') return 10; // Smaller other funders
        return 14; // Grantees
      })
      .attr('fill', d => {
        if (d.central) return 'rgb(113, 206, 126)'; // Green for central foundation
        if (d.type === 'funder') return '#802e87'; // Purple for other funders
        return '#ea8535'; // Orange for grantees
      })
      .attr('fill-opacity', d => {
        // Other funders slightly transparent to reduce clutter
        return (d.type === 'funder' && !d.central) ? 0.85 : 1;
      })
      .attr('stroke', '#fff')
      .attr('stroke-width', d => {
        return d.central ? 3 : 2;
      })
      .on('click', (event, d) => {
        event.stopPropagation();
        onNodeClickRef.current?.(d);
      })
      .on('mouseenter', function() {
        d3.select(this).attr('stroke-width', 4);
      })
      .on('mouseleave', function(_event, d) {
        // Don't reset stroke if this is the selected node
        if (selectedNodeId && d.id === selectedNodeId) return;
        d3.select(this).attr('stroke-width', d.central ? 3 : 2);
      });

    // Add labels to nodes with white background for better readability
    // First add a white background/halo
    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', d => d.central ? -28 : -18)
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.central ? 14 : 11)
      .attr('font-weight', d => d.central ? 'bold' : 'normal')
      .attr('fill', 'white')
      .attr('stroke', 'white')
      .attr('stroke-width', 3)
      .attr('paint-order', 'stroke')
      .style('pointer-events', 'none');

    // Then add the actual text on top
    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', d => d.central ? -28 : -18)
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.central ? 14 : 11)
      .attr('font-weight', d => d.central ? 'bold' : 'normal')
      .attr('fill', '#1f2937')
      .style('pointer-events', 'none');

    // Update positions on tick
    simulation.on('tick', () => {
      link.attr('d', (d: any) => {
        const source = d.source as SimulationNode;
        const target = d.target as SimulationNode;

        // If multiple links between same nodes (d.size > 1), create curved paths
        if (d.size && d.size > 1 && d.linknum) {
          const dx = target.x! - source.x!;
          const dy = target.y! - source.y!;
          const dr = Math.sqrt(dx * dx + dy * dy);

          // Calculate curvature based on linknum
          // Positive linknum = curve above, negative = curve below
          const curvature = d.linknum * 30; // 30 pixels of curve per linknum

          // Use quadratic bezier curve for smoother arcs
          const midX = (source.x! + target.x!) / 2;
          const midY = (source.y! + target.y!) / 2;

          // Perpendicular offset for curve control point
          const offsetX = -dy / dr * curvature;
          const offsetY = dx / dr * curvature;

          return `M${source.x},${source.y}Q${midX + offsetX},${midY + offsetY} ${target.x},${target.y}`;
        }

        // Straight line for single edges
        return `M${source.x},${source.y}L${target.x},${target.y}`;
      });

      linkLabel
        .attr('x', d => ((d.source as unknown as SimulationNode).x! + (d.target as unknown as SimulationNode).x!) / 2)
        .attr('y', d => ((d.source as unknown as SimulationNode).y! + (d.target as unknown as SimulationNode).y!) / 2);

      node.attr('transform', d => `translate(${(d as SimulationNode).x},${(d as SimulationNode).y})`);
    });

    return () => {
      simulation.stop();
    };
  }, [data, width, height]);

  // Separate effect for highlighting selected node (doesn't restart simulation)
  useEffect(() => {
    if (!nodesRef.current) return;

    // Update all circles' stroke based on selection
    nodesRef.current.selectAll('circle')
      .attr('stroke', (d: SimulationNode) => {
        if (selectedNodeId && d.id === selectedNodeId) return '#fbbf24'; // Yellow for selected
        return '#fff'; // White for others
      })
      .attr('stroke-width', (d: SimulationNode) => {
        if (selectedNodeId && d.id === selectedNodeId) return 4; // Thicker for selected
        return d.central ? 3 : 2;
      });
  }, [selectedNodeId]);

  return (
    <svg ref={svgRef} className="w-full h-full bg-white" />
  );
}
