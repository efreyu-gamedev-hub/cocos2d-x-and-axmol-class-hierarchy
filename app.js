// --- State ---
let roots = [], selectedNode = null, currentSrc = null;
let i = 0;
const duration = 500;

// --- Layout ---
const PANEL_WIDTH = 380;
const margin = { top: 20, right: 20, bottom: 20, left: 40 };

function getTreeSize() {
    const w = window.innerWidth - PANEL_WIDTH - margin.left - margin.right;
    const h = window.innerHeight - margin.top - margin.bottom;
    return { width: Math.max(w, 400), height: Math.max(h, 300) };
}

// --- SVG Setup ---
const svgContainer = d3.select("#canvas");
const svg = svgContainer.append("svg");
const gZoom = svg.append("g");
const gTree = gZoom.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

// Zoom behavior
const zoom = d3.zoom()
    .scaleExtent([0.2, 3])
    .on("zoom", (event) => gZoom.attr("transform", event.transform));
svg.call(zoom);

function resizeSVG() {
    const size = getTreeSize();
    svg.attr("width", size.width + margin.left + margin.right)
       .attr("height", size.height + margin.top + margin.bottom);
}
resizeSVG();

// --- Color palette by depth ---
const depthColors = [
    "#6366f1", // 0 - indigo
    "#3b82f6", // 1 - blue
    "#06b6d4", // 2 - cyan
    "#10b981", // 3 - emerald
    "#f59e0b", // 4 - amber
    "#ef4444", // 5 - red
    "#8b5cf6", // 6 - violet
    "#ec4899", // 7 - pink
];

function getColor(d) {
    // Use custom color from data if available, otherwise depth-based
    if (d.data && d.data.color) return d.data.color;
    return depthColors[(d.depth - 1) % depthColors.length];
}

// --- Node width calculation ---
function getNodeWidth(d) {
    return d.data.name.length * 8 + 24;
}

// --- Count all descendants ---
function countDescendants(d) {
    if (!d.children && !d._children) return 0;
    const ch = d.children || d._children || [];
    let count = ch.length;
    ch.forEach(c => count += countDescendants(c));
    return count;
}

// --- Count visible nodes for dynamic height ---
function countVisibleNodes(d) {
    if (!d.children) return 1;
    let count = 0;
    d.children.forEach(c => count += countVisibleNodes(c));
    return Math.max(count, 1);
}

// --- Preloader ---
const preloader = document.getElementById("preloader");

function showPreloader() {
    preloader.classList.remove("hidden");
}

function hidePreloader() {
    preloader.classList.add("hidden");
}

// --- Detail panel rendering ---
function renderDetail(d) {
    const panel = d3.select("#detail-content");
    if (!d || d.data.__virtual) {
        panel.html(`<div class="detail-empty">Click on a node to see its details</div>`);
        return;
    }
    const data = d.data;
    const color = getColor(d);
    const childCount = (d.children || d._children || []).length;
    const totalDesc = countDescendants(d);

    let html = `
        <div class="detail-header" style="border-left: 4px solid ${color}; padding-left: 12px;">
            <div class="detail-name" style="color: ${color}">${escapeHtml(data.name)}</div>
            <div class="detail-header-file">${escapeHtml(data.header || '')}</div>
        </div>
        <div class="detail-description">${escapeHtml(data.description || '')}</div>
        <div class="detail-stats">
            <span class="stat-badge">Depth: ${d.depth - 1}</span>
            ${childCount > 0 ? `<span class="stat-badge">Children: ${childCount}</span>` : ''}
            ${totalDesc > 0 ? `<span class="stat-badge">Total subtree: ${totalDesc}</span>` : ''}
        </div>
    `;

    if (data.methods && data.methods.length > 0) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Methods (${data.methods.length})</div>
            <ul class="detail-list detail-list-methods">
                ${data.methods.map(m => {
                    const name = typeof m === 'string' ? m : m.name;
                    const desc = typeof m === 'string' ? '' : (m.description || '');
                    return `<li title="${escapeHtml(desc)}">${escapeHtml(name)}</li>`;
                }).join('')}
            </ul>
        </div>`;
    }

    // Ancestry path (skip virtual root)
    const path = [];
    let current = d;
    while (current) {
        if (!current.data.__virtual) path.unshift(current.data.name);
        current = current.parent;
    }
    if (path.length > 1) {
        html += `<div class="detail-section">
            <div class="detail-section-title">Inheritance</div>
            <div class="detail-breadcrumb">${path.map(escapeHtml).join(' &rarr; ')}</div>
        </div>`;
    }

    panel.html(html);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Search ---
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
let allNodes = [];

function flattenTree(node, arr) {
    if (!node.data.__virtual) arr.push(node);
    if (node.children) node.children.forEach(c => flattenTree(c, arr));
    if (node._children) node._children.forEach(c => flattenTree(c, arr));
}

function getVirtualRoot() {
    return roots.length > 0 ? roots[0].parent : null;
}

function doSearch(query) {
    const vroot = getVirtualRoot();
    if (!query || query.length < 2 || !vroot) {
        searchResults.style.display = "none";
        return;
    }
    const q = query.toLowerCase();
    allNodes = [];
    flattenTree(vroot, allNodes);
    const matches = allNodes.filter(n => n.data.name.toLowerCase().includes(q)).slice(0, 10);
    if (matches.length === 0) {
        searchResults.style.display = "none";
        return;
    }
    searchResults.innerHTML = matches.map(n =>
        `<div class="search-item" data-name="${escapeHtml(n.data.name)}">${escapeHtml(n.data.name)}</div>`
    ).join('');
    searchResults.style.display = "block";
    searchResults.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => {
            const name = el.dataset.name;
            allNodes = [];
            flattenTree(vroot, allNodes);
            const target = allNodes.find(n => n.data.name === name);
            if (target) {
                expandToNode(target);
                selectNode(target);
                update(vroot);
                centerOnNode(target);
            }
            searchResults.style.display = "none";
            searchInput.value = '';
        });
    });
}

function expandToNode(node) {
    const path = [];
    let current = node.parent;
    while (current) {
        path.unshift(current);
        current = current.parent;
    }
    path.forEach(n => {
        if (n._children) {
            n.children = n._children;
            n._children = null;
        }
    });
}

function centerOnNode(node) {
    setTimeout(() => {
        const size = getTreeSize();
        const x = -(node.y) + size.width / 3;
        const y = -(node.x) + size.height / 2;
        svg.transition().duration(500).call(
            zoom.transform,
            d3.zoomIdentity.translate(x + margin.left, y + margin.top)
        );
    }, duration + 50);
}

searchInput.addEventListener('input', (e) => doSearch(e.target.value));
searchInput.addEventListener('blur', () => {
    setTimeout(() => searchResults.style.display = "none", 200);
});

// --- Collapse / Expand All ---
document.getElementById("btn-collapse").addEventListener("click", () => {
    const vroot = getVirtualRoot();
    if (!vroot) return;
    collapseAll(vroot);
    // Keep virtual root and first-level roots expanded
    vroot.children = vroot._children;
    vroot._children = null;
    update(vroot);
});

document.getElementById("btn-expand").addEventListener("click", () => {
    const vroot = getVirtualRoot();
    if (!vroot) return;
    expandAll(vroot);
    update(vroot);
});

document.getElementById("btn-fit").addEventListener("click", fitView);

function collapseAll(d) {
    if (d.children) {
        d.children.forEach(collapseAll);
        d._children = d.children;
        d.children = null;
    }
}

function expandAll(d) {
    if (d._children) {
        d.children = d._children;
        d._children = null;
    }
    if (d.children) d.children.forEach(expandAll);
}

function fitView() {
    svg.transition().duration(500).call(
        zoom.transform,
        d3.zoomIdentity.translate(margin.left, margin.top).scale(1)
    );
}

// --- Select node ---
function selectNode(d) {
    selectedNode = d;
    renderDetail(d);
    gTree.selectAll('g.node').classed('selected', false);
    gTree.selectAll('g.node')
        .filter(n => n === d)
        .classed('selected', true);
}

// --- Main update ---
function update(source) {
    const vroot = getVirtualRoot();
    if (!vroot) return;

    const visibleCount = countVisibleNodes(vroot);
    const nodeHeight = 36;
    const treeHeight = Math.max(visibleCount * nodeHeight, getTreeSize().height);
    const treeWidth = getTreeSize().width;

    const treeMap = d3.tree()
        .size([treeHeight, treeWidth - 160])
        .separation((a, b) => a.parent === b.parent ? 1 : 1.2);

    const treeData = treeMap(vroot);
    const allDescendants = treeData.descendants();
    // Filter out the virtual root from rendering
    const nodes = allDescendants.filter(d => !d.data.__virtual);
    const links = allDescendants.filter(d => d.parent && !d.data.__virtual);

    allDescendants.forEach(d => d.y = d.depth * 220);

    // --- Nodes ---
    const node = gTree.selectAll('g.node')
        .data(nodes, d => d.id || (d.id = ++i));

    const nodeEnter = node.enter().append('g')
        .attr('class', 'node')
        .attr("transform", `translate(${source.y0 || 0},${source.x0 || 0})`)
        .on('click', (event, d) => {
            event.stopPropagation();
            if (event.ctrlKey || event.metaKey) {
                if (d.children) { d._children = d.children; d.children = null; }
                else if (d._children) { d.children = d._children; d._children = null; }
                update(d);
            } else {
                selectNode(d);
            }
        })
        .on('dblclick', (event, d) => {
            event.stopPropagation();
            if (d.children) { d._children = d.children; d.children = null; }
            else if (d._children) { d.children = d._children; d._children = null; }
            update(d);
        });

    nodeEnter.append('rect')
        .attr('class', 'node-bg')
        .attr('rx', 6)
        .attr('ry', 6)
        .attr('x', 0)
        .attr('y', -14)
        .attr('width', 16)
        .attr('height', 28);

    nodeEnter.append('circle')
        .attr('class', 'node-port-in')
        .attr('r', 4)
        .attr('cx', 0)
        .attr('cy', 0);

    nodeEnter.append('text')
        .attr('class', 'node-label')
        .attr("dy", ".35em")
        .attr("x", 12)
        .text(d => d.data.name);

    nodeEnter.append('circle')
        .attr('class', 'node-port-out')
        .attr('r', 4)
        .attr('cy', 0);

    nodeEnter.append('text')
        .attr('class', 'node-badge')
        .attr("dy", ".35em");

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.transition().duration(duration)
        .attr("transform", d => `translate(${d.y},${d.x})`);

    nodeUpdate.select('.node-bg')
        .transition().duration(duration)
        .attr('width', d => getNodeWidth(d))
        .style("fill", d => {
            if (selectedNode === d) return getColor(d);
            return d._children ? getColor(d) + '22' : 'transparent';
        })
        .style("stroke", d => getColor(d))
        .style("stroke-width", d => selectedNode === d ? '2px' : '1px');

    nodeUpdate.select('.node-port-in')
        .style("fill", d => d.parent && !d.parent.data.__virtual ? getColor(d) : '#fff')
        .style("stroke", d => getColor(d))
        .style("stroke-width", '2px')
        .style("display", d => d.parent && !d.parent.data.__virtual ? 'block' : 'none');

    nodeUpdate.select('.node-port-out')
        .attr('cx', d => getNodeWidth(d))
        .style("fill", d => {
            if (d._children) return getColor(d);
            if (d.children) return '#fff';
            return 'none';
        })
        .style("stroke", d => (d.children || d._children) ? getColor(d) : 'none')
        .style("stroke-width", '2px')
        .style("display", d => (d.children || d._children) ? 'block' : 'none');

    nodeUpdate.select('.node-label')
        .style("fill", d => selectedNode === d ? '#fff' : '#f1f5f9')
        .style("font-weight", d => selectedNode === d ? '700' : (d._children ? '600' : '500'));

    nodeUpdate.select('.node-badge')
        .text(d => {
            const count = (d._children || []).length;
            return count > 0 ? `+${count}` : '';
        })
        .style("fill", d => getColor(d))
        .attr("x", d => getNodeWidth(d) + 10);

    nodeUpdate.classed('selected', d => selectedNode === d);

    const nodeExit = node.exit().transition().duration(duration)
        .attr("transform", `translate(${source.y},${source.x})`)
        .remove();

    nodeExit.select('.node-bg').style('opacity', 0);
    nodeExit.select('.node-label').style('opacity', 0);

    // --- Links (skip links from virtual root to top-level roots) ---
    const linkData = links.filter(d => !d.parent.data.__virtual);
    const link = gTree.selectAll('path.link')
        .data(linkData, d => d.id);

    const linkEnter = link.enter().insert('path', "g")
        .attr("class", "link")
        .attr('d', () => {
            const o = { x: source.x0 || 0, y: source.y0 || 0, data: source.data };
            return diagonal(o, o);
        });

    link.merge(linkEnter).transition().duration(duration)
        .attr('d', d => diagonal(d, d.parent))
        .style('stroke', d => getColor(d) + '55');

    link.exit().transition().duration(duration)
        .attr('d', () => {
            const o = { x: source.x, y: source.y, data: source.data };
            return diagonal(o, o);
        })
        .remove();

    allDescendants.forEach(d => { d.x0 = d.x; d.y0 = d.y; });

    function diagonal(s, d) {
        const parentRight = d.y + getNodeWidth(d);
        const childLeft = s.y;
        return `M ${childLeft} ${s.x}
                C ${(childLeft + parentRight) / 2} ${s.x},
                  ${(childLeft + parentRight) / 2} ${d.x},
                  ${parentRight} ${d.x}`;
    }
}

// --- Load data ---
function loadEngine(src, updateHash = true) {
    if (src === currentSrc) return;
    currentSrc = src;

    // Update active tab and URL hash
    document.querySelectorAll('.engine-tab').forEach(tab => {
        const isActive = tab.dataset.src === src;
        tab.classList.toggle('active', isActive);
        if (isActive && updateHash) {
            history.replaceState(null, '', '#' + tab.dataset.hash);
        }
    });

    showPreloader();
    selectedNode = null;
    renderDetail(null);

    // Clear existing tree
    gTree.selectAll('*').remove();
    i = 0;

    fetch(src)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            // data is an array of root trees
            const arr = Array.isArray(data) ? data : [data];

            // Create virtual root to hold multiple trees
            const virtualRoot = {
                name: "__root__",
                __virtual: true,
                children: arr,
            };

            const vroot = d3.hierarchy(virtualRoot, d => d.children);
            vroot.x0 = getTreeSize().height / 2;
            vroot.y0 = 0;

            // Store references to top-level roots
            roots = vroot.children || [];

            // Collapse children of each root by default (keep roots visible)
            // Exception: "Node" stays expanded at first level
            roots.forEach(r => {
                if (r.children) {
                    r.children.forEach(child => {
                        if (child.data.name === "Node" && child.children) {
                            child.children.forEach(collapseAll);
                        } else {
                            collapseAll(child);
                        }
                    });
                }
            });

            hidePreloader();
            update(vroot);
            fitView();
        })
        .catch(err => {
            hidePreloader();
            console.error(`Failed to load ${src}:`, err);
            d3.select("#detail-content").html(
                `<div class="detail-empty" style="color:#ef4444">Error loading ${escapeHtml(src)}.<br>Make sure to serve via HTTP (not file://).</div>`
            );
        });
}

// --- Engine tabs ---
document.querySelectorAll('.engine-tab').forEach(tab => {
    tab.addEventListener('click', () => loadEngine(tab.dataset.src));
});

// --- Hash navigation ---
function loadFromHash() {
    const hash = location.hash.replace('#', '');
    if (!hash) return false;
    const tab = document.querySelector(`.engine-tab[data-hash="${hash}"]`);
    if (tab) {
        loadEngine(tab.dataset.src, false);
        return true;
    }
    return false;
}

window.addEventListener('hashchange', () => loadFromHash());

// --- Init: load from hash or default ---
if (!loadFromHash()) {
    loadEngine('cocos2d-x.json');
}

// --- Resize ---
window.addEventListener('resize', () => {
    resizeSVG();
    const vroot = getVirtualRoot();
    if (vroot) update(vroot);
});

// Click on empty area to deselect
svg.on('click', () => {
    selectedNode = null;
    renderDetail(null);
    gTree.selectAll('g.node').classed('selected', false);
});
