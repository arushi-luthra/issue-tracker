// public/app.js

// Base API URL (same origin)
const apiBase = '';
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${wsProto}://${location.host}`);

let state = { nextId: 1, issues: [] };

// Handle messages from the WebSocket server
socket.addEventListener('message', ev => {
  try {
    const data = JSON.parse(ev.data);

    if (data.type === 'issue_created') {
      state.issues.push(data.issue);
      renderTable();
    } else if (data.type === 'issue_commented') {
      const issue = state.issues.find(i => i.id === data.id);
      if (issue) {
        issue.comments.push(data.comment);
        renderTable();
      }
    } else if (data.type === 'issue_updated') {
      const idx = state.issues.findIndex(i => i.id === data.issue.id);
      if (idx >= 0) state.issues[idx] = data.issue;
      else state.issues.push(data.issue);
      renderTable();
    }
  } catch (err) {
    console.error('WS message parse error', err);
  }
});

// Fetch the current issues when page loads
async function fetchState() {
  try {
    const res = await fetch('/api/issues');
    if (!res.ok) throw new Error('Failed to fetch issues');
    const data = await res.json();
    state = data;
    renderTable();
  } catch (err) {
    console.error('Error fetching state:', err);
  }
}

// Render the issue table dynamically
function renderTable() {
  const tbody = document.querySelector('#issues-table tbody');
  tbody.innerHTML = '';

  for (const issue of state.issues) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${issue.id}</td>
      <td>${escapeHtml(issue.title)}</td>
      <td>${escapeHtml(issue.status)}</td>
      <td>${escapeHtml(issue.createdBy)}</td>
      <td>
        <details>
          <summary>${issue.comments.length} comment(s)</summary>
          <ul>
            ${issue.comments
              .map(c => `<li><strong>${escapeHtml(c.author)}:</strong> ${escapeHtml(c.text)}</li>`)
              .join('')}
          </ul>
          <form data-id="${issue.id}" class="comment-form">
            <input name="author" placeholder="Your name" required />
            <input name="text" placeholder="Comment" required />
            <button type="submit">Post</button>
          </form>
        </details>
      </td>
      <td>
        <select data-id="${issue.id}" class="status-select">
          <option ${issue.status === 'Open' ? 'selected' : ''}>Open</option>
          <option ${issue.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
          <option ${issue.status === 'Closed' ? 'selected' : ''}>Closed</option>
        </select>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Comment form handler
  document.querySelectorAll('.comment-form').forEach(form => {
    form.onsubmit = async e => {
      e.preventDefault();
      const id = form.dataset.id;
      const fd = new FormData(form);
      const body = { author: fd.get('author'), text: fd.get('text') };
      try {
        const res = await fetch(`/api/issues/${id}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json();
          return alert('Error: ' + (err.error || 'unknown'));
        }
        form.reset();
        // No need to update UI here — server will broadcast the comment to everyone
      } catch (err) {
        console.error('Error posting comment', err);
      }
    };
  });

  // Status change handler
  document.querySelectorAll('.status-select').forEach(sel => {
    sel.onchange = async e => {
      const id = sel.dataset.id;
      const status = sel.value;
      const updatedBy = prompt('Enter your name for the status update');
      if (!updatedBy) {
        // revert to previous value (refetch to get server truth)
        fetchState();
        return alert('Name required');
      }
      try {
        const res = await fetch(`/api/issues/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, updatedBy })
        });
        if (!res.ok) {
          const err = await res.json();
          alert('Error: ' + (err.error || 'unknown'));
          fetchState();
        }
        // server will broadcast the update
      } catch (err) {
        console.error('Error updating status', err);
      }
    };
  });
}

// Escape HTML for security
function escapeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// New issue form handler
const newForm = document.getElementById('new-issue-form');
newForm.onsubmit = async e => {
  e.preventDefault();
  const title = document.getElementById('title').value.trim();
  const description = document.getElementById('description').value.trim();
  const createdBy = document.getElementById('createdBy').value.trim();
  if (!title || !createdBy) return alert('Title and your name required');

  try {
    const res = await fetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, createdBy })
    });
    if (!res.ok) {
      const err = await res.json();
      return alert('Error: ' + (err.error || 'unknown'));
    }
    document.getElementById('title').value = '';
    document.getElementById('description').value = '';
    // server broadcasts created issue to all clients
  } catch (err) {
    console.error('Error creating issue', err);
  }
};

// Initialize the table on load
fetchState();
