const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const communityReactionOptions = [["\u{1F44D}","Like"],["\u2764\uFE0F","Love"],["\u{1F602}","Funny"],["\u{1F62E}","Wow"],["\u{1F622}","Sad"],["\u{1F64F}","Thankful"],["\u{1F44F}","Applause"],["\u{1F525}","Fire"],["\u{1F389}","Celebrate"],["\u{1F60D}","Love it"],["\u{1F970}","Caring"],["\u{1F914}","Thinking"],["\u{1F621}","Angry"],["\u{1F64C}","Praise"],["\u{1F4AA}","Strong"],["\u{1F4AF}","100"],["\u{1F440}","Eyes"],["\u2705","Agree"],["\u2728","Sparkles"],["\u{1F91D}","Support"],["\u{1F917}","Hug"],["\u{1F606}","Laugh"],["\u{1F615}","Confused"],["\u2764\uFE0F\u200D\u{1F525}","Heart on fire"]];
const statuses = ["Not Started", "In Progress", "Completed", "On Hold", "Not Applicable"];
const reportColumns = [
  ["activity", "Activity", "Describe the activity"],
  ["action", "Action", "Action taken or planned"],
  ["dateBy", "Date By", "Date or person responsible"],
  ["progressUpdate", "Progress Update", "Describe progress"],
  ["followUpAction", "Follow-up Action", "Next steps"],
  ["comments", "Comments", "Additional comments"]
];
const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");
const adminScreen = document.getElementById("adminScreen");
const pageShell = document.querySelector(".page-shell");
const form = document.getElementById("weeklyActivityForm");
const message = document.getElementById("formMessage");
let loginRole = "user";
let signedInUser = null;
let activeDashboard = "";
let draftWeek = "";
let draftSaveTimer = null;
let loadingDraft = false;
let publicHolidayMap = new Map();
let activityNotificationKeys = [];
let activityNotificationTimer = null;

function activityNotificationStorageKey() { return `seen-activity-updates-${signedInUser?.id || ""}`; }
function updateActivityNotification(activities) {
  const incoming = activities.flatMap(activity => [
    `assigned:${activity.id}`,
    ...(activity.updates || []).filter(update => update.authorId !== signedInUser?.id).map(update => `update:${update.id}`)
  ]);
  activityNotificationKeys = incoming;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(activityNotificationStorageKey()) || "[]"); } catch { /* Treat unread updates as new if storage is unavailable. */ }
  document.getElementById("activityUpdateIndicator").hidden = !incoming.some(key => !seen.includes(key));
}
function markActivityNotificationsSeen() {
  try { localStorage.setItem(activityNotificationStorageKey(), JSON.stringify(activityNotificationKeys)); } catch { /* The indicator can still be cleared for this visit. */ }
  const indicator = document.getElementById("activityUpdateIndicator");
  if (indicator) indicator.hidden = true;
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const responseText = await response.text();
  let result;
  try { result = responseText ? JSON.parse(responseText) : {}; }
  catch {
    const preview = responseText.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`The server returned a non-JSON response (${response.status}) for ${url}.${preview ? " " + preview : ""}`);
  }
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function showMessage(element, text, kind = "error") { element.textContent = text; element.className = `form-message ${kind}`; }
function initials(name = "") { return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join(""); }
function displayProfilePicture(picture) { const preview=document.getElementById("sharedProfilePicture"),fallback=document.getElementById("sharedProfileInitials");preview.hidden=!picture;preview.src=picture||"";fallback.textContent=initials(signedInUser?.fullName||"");fallback.hidden=Boolean(picture); }
function displayAdminProfilePicture(picture) { displayProfilePicture(picture); }
async function loadAdminProfilePicture() { try { const {picture}=await api("/api/my/profile-picture");displayAdminProfilePicture(picture); } catch { /* Keep the profile fallback visible if the photo is unavailable. */ } }
async function loadProfilePicture() {
  try { const { picture } = await api("/api/my/profile-picture"); displayProfilePicture(picture); }
  catch { /* Keep the photo area empty if the saved picture cannot be loaded. */ }
}
function currentMonday() {
  const today = new Date(); const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}
function currentPortalDate() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lusaka", weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date());
}
function renderDays() {
  document.getElementById("daysContainer").innerHTML = days.map((day, index) => `
    <article class="day-card daily-report-card" data-report-day="${day}"><div class="day-top"><span class="day-name">${day}</span></div>
      <p class="public-holiday-notice" hidden></p><div class="day-entry-fields">
      <label class="daily-status" for="status-${index}">Activity status<select id="status-${index}" name="status-${day.toLowerCase()}" required>
        <option value="">Select status</option>${statuses.map(status => `<option value="${status}">${status}</option>`).join("")}
      </select></label>
      <div class="daily-table-scroll"><table class="daily-report-table"><thead><tr>${reportColumns.map(([, title]) => `<th scope="col">${title}</th>`).join("")}</tr></thead><tbody><tr>${reportColumns.map(([key, title, hint]) => `<td>${key === "dateBy" ? `<input type="date" id="${day.toLowerCase()}-${key}" name="${day.toLowerCase()}-${key}" aria-label="${day}: ${title}">` : `<textarea id="${day.toLowerCase()}-${key}" name="${day.toLowerCase()}-${key}" aria-label="${day}: ${title}" placeholder="${hint}" ${key === "activity" ? "required" : ""}></textarea>`}</td>`).join("")}</tr></tbody></table></div></div>
    </article>`).join("");
}
function weekdayDate(week, index) {
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
}
async function refreshPublicHolidays() {
  const { holidays } = await api("/api/holidays");
  publicHolidayMap = new Map(holidays.map(holiday => [holiday.date, holiday]));
  const week = document.getElementById("weekCommencing").value;
  if (week) applyPublicHolidayLocks(week);
}
function applyPublicHolidayLocks(week) {
  document.querySelectorAll("[data-report-day]").forEach((card, index) => {
    const holiday = publicHolidayMap.get(weekdayDate(week, index));
    const notice = card.querySelector(".public-holiday-notice");
    const entryFields = card.querySelector(".day-entry-fields");
    notice.hidden = !holiday;
    notice.textContent = holiday ? `${holiday.name || "Public holiday"} · ${formatWeekCommencing(holiday.date)}. Activity reporting is disabled for this day.` : "";
    entryFields.hidden = Boolean(holiday);
    card.classList.toggle("is-public-holiday", Boolean(holiday));
    card.querySelectorAll("input, textarea, select").forEach(control => {
      control.disabled = Boolean(holiday);
      if (control.name.endsWith("-activity")) control.required = !holiday;
      if (control.name.startsWith("status-") && holiday) control.value = "Not Applicable";
    });
  });
}
async function loadHolidayAdmin() {
  const table = document.getElementById("holidayTable");
  try {
    const { holidays } = await api("/api/admin/holidays");
    table.innerHTML = holidays.map(holiday => `<tr><td><input type="date" data-holiday-date="${escapeHtml(holiday.date)}" value="${escapeHtml(holiday.date)}" required></td><td><input type="text" data-holiday-name="${escapeHtml(holiday.date)}" value="${escapeHtml(holiday.name || "")}" maxlength="100" aria-label="Holiday name"></td><td><button type="button" class="btn btn-secondary" data-save-holiday="${escapeHtml(holiday.date)}">Save</button> <button type="button" class="btn btn-secondary" data-remove-holiday="${escapeHtml(holiday.date)}">Remove</button></td></tr>`).join("") || '<tr><td colspan="3">No public holidays have been designated.</td></tr>';
    table.querySelectorAll("[data-save-holiday]").forEach(button => button.addEventListener("click", async () => {
      const oldDate = button.dataset.saveHoliday;
      const date = table.querySelector(`[data-holiday-date="${oldDate}"]`).value;
      const name = table.querySelector(`[data-holiday-name="${oldDate}"]`).value;
      try { await api(`/api/admin/holidays/${oldDate}`, { method: "PUT", body: JSON.stringify({ date, name }) }); showMessage(document.getElementById("holidayMessage"), "Public holiday updated.", "success"); await loadHolidayAdmin(); await refreshPublicHolidays(); }
      catch (error) { showMessage(document.getElementById("holidayMessage"), error.message); }
    }));
    table.querySelectorAll("[data-remove-holiday]").forEach(button => button.addEventListener("click", async () => {
      try { await api(`/api/admin/holidays/${button.dataset.removeHoliday}`, { method: "DELETE" }); showMessage(document.getElementById("holidayMessage"), "Public holiday removed.", "success"); await loadHolidayAdmin(); await refreshPublicHolidays(); }
      catch (error) { showMessage(document.getElementById("holidayMessage"), error.message); }
    }));
  } catch (error) { showMessage(document.getElementById("holidayMessage"), error.message); }
}
function renderReportDays(activities = []) {
  return activities.map((item, index) => `<article class="report-day-detail"><div class="day-top"><span class="day-name">${escapeHtml(item.day || days[index] || "Day")}</span><span class="status-pill">${escapeHtml(item.status || "")}</span></div><div class="daily-table-scroll"><table class="daily-report-table report-detail-table"><thead><tr>${reportColumns.map(([, title]) => `<th scope="col">${title}</th>`).join("")}</tr></thead><tbody><tr>${reportColumns.map(([key]) => `<td>${escapeHtml(item[key] ?? (key === "activity" ? item.activity : "") ?? "")}</td>`).join("")}</tr></tbody></table></div></article>`).join("");
}
function buildDashboardNavigation(user) {
  const choices = user.role === "admin" ? [
    ["Manage User Accounts", "admin-users"],
    ["Public Holiday Management", "admin-holidays"],
    ["Community Engagement", "community"],
    ...(user.isLineManager ? [["Review and Comment on Reports", "manager-reports"], ["Activity Assignment and Deadline Management", "manager-activities"]] : [])
  ] : [
    ["Writing Weekly Report", "weekly"],
    ["Submitted Reports", "reports"],
    ["Deadline Activities", "assigned"],
    ["Community Engagement", "community"],
    ...(user.isLineManager ? [["Review and Comment on Reports", "manager-reports"], ["Activity Assignment and Deadline Management", "manager-activities"]] : [])
  ];
  document.getElementById("dashboardNav").innerHTML = choices.map(([label, view]) => '<button type="button" class="dashboard-nav-link" data-nav-dashboard="' + view + '">' + label + '</button>').join("");
}
function setNavigationOpen(open) {
  const root = document.getElementById("appNavigation");
  const toggle = document.getElementById("menuToggle");
  const sidebar = document.getElementById("navSidebar");
  const backdrop = document.getElementById("navBackdrop");
  root.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Close dashboard navigation" : "Open dashboard navigation");
  sidebar.setAttribute("aria-hidden", String(!open));
  sidebar.inert = !open;
  backdrop.hidden = !open;
}
document.getElementById("menuToggle").addEventListener("click", () => setNavigationOpen(document.getElementById("menuToggle").getAttribute("aria-expanded") !== "true"));
document.getElementById("sidebarClose").addEventListener("click", () => setNavigationOpen(false));
document.getElementById("navBackdrop").addEventListener("click", () => setNavigationOpen(false));
document.getElementById("dashboardNav").addEventListener("click", event => {
  const button = event.target.closest("[data-nav-dashboard]");
  if (!button) return;
  openDashboard(button.dataset.navDashboard);
  setNavigationOpen(false);
});
document.addEventListener("keydown", event => { if (event.key === "Escape" && document.getElementById("menuToggle").getAttribute("aria-expanded") === "true") { setNavigationOpen(false); document.getElementById("menuToggle").focus(); } });
function openDashboard(view) {
  const admin = signedInUser?.role === "admin";
  const lineManager = Boolean(signedInUser?.isLineManager);
  const viewLabels = {
    weekly: "Writing Weekly Report", reports: "Submitted Reports", assigned: "Deadline Activities",
    community: "Community Engagement", "manager-reports": "Review and Comment on Reports",
    "manager-activities": "Activity Assignment and Deadline Management",
    "admin-users": "Manage User Accounts", "admin-holidays": "Public Holiday Management"
  };
  const allowed = admin
    ? ["admin-users", "admin-holidays", "community", ...(lineManager ? ["manager-reports", "manager-activities"] : [])]
    : ["weekly", "reports", "assigned", "community", ...(lineManager ? ["manager-reports", "manager-activities"] : [])];
  if (!allowed.includes(view)) return;
  activeDashboard = view;
  document.getElementById("activeDashboardTitle").textContent = viewLabels[view];
  if (activityNotificationTimer) clearInterval(activityNotificationTimer);
  activityNotificationTimer = null;
  document.getElementById("dashboardHome").hidden = true;
  document.getElementById("adminScreen").hidden = !admin;
  document.querySelector(".admin-content").hidden = !admin || view === "manager-reports" || view === "manager-activities";
  document.getElementById("adminCommunitySection").hidden = !admin || view !== "community";
  document.getElementById("adminUsersSection").hidden = !admin || view !== "admin-users";
  document.getElementById("adminHolidaysSection").hidden = !admin || view !== "admin-holidays";
  document.getElementById("adminReviewSection").hidden = !admin || view !== "manager-reports";
  document.getElementById("adminActivitySection").hidden = !admin || view !== "manager-activities";
  document.getElementById("pageShell").hidden = admin;
  if (!admin) {
    const userSections = {
      weekly: "weeklyActivityForm", reports: "myReportsSection", assigned: "myActivitiesSection",
      community: "userCommunitySection", "manager-reports": "managerReviewSection", "manager-activities": "managerActivitySection"
    };
    for (const id of Object.values(userSections)) document.getElementById(id).hidden = true;
    document.getElementById(userSections[view]).hidden = false;
  }
  if (view === "weekly") {
    document.getElementById("weekCommencing").value = currentMonday();
    startReportDraft();
  } else if (view === "reports") loadMyReports();
  else if (view === "assigned") {
    loadMyActivities();
    activityNotificationTimer = setInterval(loadMyActivities, 30000);
  } else if (view === "community") loadCommunityFeed(admin ? "admin" : "user");
  else if (view === "manager-reports") {
    if (admin) loadManagerReports("adminManagerUsers", "adminManagerReports", "adminSelectedUserHeading", "adminManagerMessage");
    else loadManagerReports();
  } else if (view === "manager-activities") loadManagerActivities(admin ? "admin" : "user");
  else if (view === "admin-users") loadUsers();
  else if (view === "admin-holidays") loadHolidayAdmin();
  document.querySelectorAll(".dashboard-nav-link").forEach(button => button.classList.toggle("is-current", button.dataset.navDashboard === view));
}
function openDashboardFromNotificationLink() {
  const requested = new URLSearchParams(window.location.search).get("dashboard");
  if (!requested) return;
  openDashboard(requested);
  history.replaceState(null, "", window.location.pathname);
}
function showDashboard(user) {
  signedInUser = user;
  activeDashboard = "";
  loginScreen.hidden = true;
  adminScreen.hidden = true;
  pageShell.hidden = true;
  document.querySelector(".admin-content").hidden = false;
  document.getElementById("dashboardHome").hidden = false;
  document.getElementById("dashboardWelcome").textContent = "Welcome, " + user.fullName;
  document.getElementById("activeDashboardTitle").textContent = "Welcome";
  document.getElementById("globalUserName").textContent = user.fullName;
  document.getElementById("globalUserEmail").textContent = user.email;
  document.getElementById("globalCurrentDate").textContent = currentPortalDate();
  document.getElementById("globalCurrentDate").dateTime = new Date().toISOString().slice(0,10);
  document.getElementById("dashboardHeader").hidden = false;
  displayProfilePicture(user.profilePicture || null);
  displayAdminProfilePicture(user.profilePicture || null);
  loadProfilePicture();
  document.getElementById("appNavigation").hidden = false;
  setNavigationOpen(false);
  buildDashboardNavigation(user);
  if (activityNotificationTimer) clearInterval(activityNotificationTimer);
  activityNotificationTimer = null;
  const indicator = document.getElementById("activityUpdateIndicator");
  if (indicator) indicator.hidden = true;
}
function showLogin() { signedInUser = null; activeDashboard = ""; document.getElementById("dashboardHeader").hidden = true; document.getElementById("dashboardHome").hidden = true; document.getElementById("appNavigation").hidden = true; setNavigationOpen(false); if (activityNotificationTimer) clearInterval(activityNotificationTimer); activityNotificationTimer = null; loginScreen.hidden = false; pageShell.hidden = true; adminScreen.hidden = true; loginForm.hidden = true; document.querySelector(".login-options").hidden = false; loginMessage.textContent = ""; }
document.querySelectorAll("[data-login-role]").forEach(button => button.addEventListener("click", () => {
  loginRole = button.dataset.loginRole; loginForm.hidden = false; document.querySelector(".login-options").hidden = true;
  document.getElementById("loginHeading").textContent = `${loginRole === "admin" ? "Admin" : "User"} Dashboard sign in`;
  loginForm.elements.email.focus();
}));
document.getElementById("backToOptions").addEventListener("click", () => { loginForm.hidden = true; document.querySelector(".login-options").hidden = false; loginMessage.textContent = ""; });
loginForm.addEventListener("submit", async event => {
  event.preventDefault(); loginMessage.textContent = "";
  const data = new FormData(loginForm);
  try { const result = await api("/api/login", { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password"), role: loginRole }) }); loginForm.reset(); showDashboard(result.user); openDashboardFromNotificationLink(); }
  catch (error) { showMessage(loginMessage, error.message); }
});
document.querySelectorAll("[data-logout]").forEach(button => button.addEventListener("click", async () => { try { await api("/api/logout", { method: "POST" }); } finally { showLogin(); } }));

async function loadUsers() {
  const tbody = document.getElementById("usersTable");
  try {
    const { users, lineManagers } = await api("/api/admin/users");
    fillManagerOptions(lineManagers);
    tbody.innerHTML = users.map(user => {
      const manager = lineManagers.find(item => item.id === user.lineManagerId);
      return `<tr><td>${escapeHtml(user.fullName)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.department)}</td><td>${escapeHtml(user.designation)}</td><td>${manager ? escapeHtml(manager.fullName) : "—"}</td><td><button class="btn btn-secondary" data-edit="${user.id}">Edit account</button> <button class="btn btn-secondary" data-active="${user.id}">${user.active ? "Disable" : "Enable"}</button> <button class="btn btn-secondary" data-delete="${user.id}">Delete</button></td></tr>`;
    }).join("") || '<tr><td colspan="6">No user accounts yet.</td></tr>';
    tbody.querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", () => editUser(users.find(user => user.id === button.dataset.edit), lineManagers)));
    tbody.querySelectorAll("[data-active]").forEach(button => button.addEventListener("click", async () => { const target = users.find(item => item.id === button.dataset.active); try { await api(`/api/admin/users/${target.id}`, { method: "PUT", body: JSON.stringify({ active: !target.active }) }); await loadUsers(); } catch (error) { showMessage(document.getElementById("adminMessage"), error.message); } }));
    tbody.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", async () => { const target = users.find(item => item.id === button.dataset.delete); if (!confirm(`Delete ${target.email} and their saved reports?`)) return; try { await api(`/api/admin/users/${target.id}`, { method: "DELETE" }); await loadUsers(); } catch (error) { showMessage(document.getElementById("adminMessage"), error.message); } }));
  } catch (error) { showMessage(document.getElementById("adminMessage"), error.message); }
}
function fillManagerOptions(users, excludeId = "") {
  const fill = (select, excludeId = "") => {
    const selected = select.value;
    select.innerHTML = '<option value="">Select Line Manager</option>' + users.filter(user => user.id !== excludeId && user.active).map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.fullName)}${user.role === "admin" ? " (Administrator)" : ""} (${escapeHtml(user.email)})</option>`).join("");
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  };
  fill(document.getElementById("createLineManager"));
  const editSelect = document.getElementById("editLineManager");
  fill(editSelect, excludeId || document.getElementById("editUserForm").elements.id.value);
}
function editUser(user, users) {
  const editForm = document.getElementById("editUserForm");
  editForm.elements.id.value = user.id;
  editForm.elements.fullName.value = user.fullName;
  editForm.elements.email.value = user.email;
  editForm.elements.department.value = user.department;
  editForm.elements.designation.value = user.designation;
  editForm.elements.password.value = "";
  fillManagerOptions(users, user.id);
  editForm.elements.lineManagerId.value = user.lineManagerId || "";
  document.getElementById("editUserDialog").showModal();
}
document.getElementById("cancelEditUser").addEventListener("click", () => document.getElementById("editUserDialog").close());
document.getElementById("editUserForm").addEventListener("submit", async event => {
  event.preventDefault(); const editForm = event.currentTarget; const data = Object.fromEntries(new FormData(editForm)); const id = data.id; delete data.id;
  if (!data.password) delete data.password;
  try { await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(data) }); document.getElementById("editUserDialog").close(); showMessage(document.getElementById("adminMessage"), "User account updated.", "success"); await loadUsers(); }
  catch (error) { showMessage(document.getElementById("adminMessage"), error.message); }
});
function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function communityMarkup(post, currentUserId) {
  const reactions = post.reactions || {};
  const attachments = (post.attachments || []).map(item => `<a class="community-attachment" href="/api/community/posts/${encodeURIComponent(post.id)}/attachments/${encodeURIComponent(item.id)}">${escapeHtml(item.name)} (${escapeHtml(item.mimeType)})</a>`).join("");
  const comments = (post.comments || []).map(comment => `<div class="community-comment"><strong>${escapeHtml(comment.authorName)}</strong><small>${escapeHtml(new Date(comment.createdAt).toLocaleString())}</small><p>${escapeHtml(comment.text)}</p><div class="community-comment-replies">${(comment.replies || []).map(reply => `<div class="community-comment-reply"><strong>${escapeHtml(reply.authorName)}</strong><small>${escapeHtml(new Date(reply.createdAt).toLocaleString())}</small><p>${escapeHtml(reply.text)}</p></div>`).join("")}</div><form class="community-reply-form" data-community-reply="${escapeHtml(comment.id)}"><label class="sr-only" for="reply-${escapeHtml(comment.id)}">Reply to ${escapeHtml(comment.authorName)}</label><input id="reply-${escapeHtml(comment.id)}" name="text" maxlength="3000" required placeholder="Reply to this comment..."><button class="btn btn-secondary" type="submit">Reply</button></form></div>`).join("");
  return `<article class="community-post" data-post-id="${escapeHtml(post.id)}"><header><div><span class="community-type">${escapeHtml(post.type)}</span><h3>${escapeHtml(post.title)}</h3><p>Posted by ${escapeHtml(post.authorName)} · ${escapeHtml(new Date(post.createdAt).toLocaleString())}${post.updatedAt ? " · edited" : ""}</p></div>${post.authorId === currentUserId ? `<div class="community-post-actions"><button class="btn btn-secondary" type="button" data-community-edit="${escapeHtml(post.id)}">Edit</button><button class="btn btn-secondary" type="button" data-community-delete="${escapeHtml(post.id)}">Delete</button></div>` : ""}</header><p class="community-post-text">${escapeHtml(post.text).replace(/\n/g, "<br>")}</p>${attachments ? `<div class="community-attachments">${attachments}</div>` : ""}<div class="community-reactions">${communityReactionOptions.map(([emoji,label])=>{const count=(reactions[emoji]||[]).length;return '<button type="button" class="reaction-chip'+((reactions[emoji]||[]).includes(currentUserId)?' is-reacted':'')+'" data-community-react="'+emoji+'" data-post-id="'+escapeHtml(post.id)+'" aria-label="React with '+label+', '+count+' reactions" title="'+label+'">'+emoji+'<span class="reaction-count">'+count+'</span></button>';}).join("")}</div><div class="community-comments">${comments || '<p class="empty-reports">No comments yet.</p>'}</div><form class="community-comment-form" data-community-comment="${escapeHtml(post.id)}"><label class="sr-only" for="comment-${escapeHtml(post.id)}">Write a comment</label><input id="comment-${escapeHtml(post.id)}" name="text" maxlength="3000" required placeholder="Write a comment..."><button class="btn btn-secondary" type="submit">Comment</button></form></article>`;
}
async function loadCommunityFeed(prefix = signedInUser?.role === "admin" ? "admin" : "user") {
  const feed = document.getElementById(`${prefix}CommunityFeed`);
  if (!feed || !signedInUser) return;
  try {
    const { posts, currentUserId } = await api("/api/community/posts");
    feed.innerHTML = posts.map(post => communityMarkup(post, currentUserId)).join("") || '<p class="empty-reports">No community posts yet. Share the first update.</p>';
    feed.querySelectorAll("[data-community-react]").forEach(button => button.addEventListener("click", async () => { try { await api(`/api/community/posts/${button.dataset.postId}/reactions`, { method: "POST", body: JSON.stringify({ reaction: button.dataset.communityReact }) }); await loadCommunityFeed(prefix); } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); } }));
    feed.querySelectorAll("[data-community-delete]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Delete this post and its discussion?")) return; try { await api(`/api/community/posts/${button.dataset.communityDelete}`, { method: "DELETE" }); await loadCommunityFeed(prefix); } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); } }));
    feed.querySelectorAll("[data-community-edit]").forEach(button => button.addEventListener("click", async () => {
      const post = posts.find(item => item.id === button.dataset.communityEdit); if (!post) return;
      const title = prompt("Edit post title:", post.title); if (title === null) return;
      const text = prompt("Edit post message:", post.text); if (text === null) return;
      const type = prompt("Post type: update, story, announcement, news, or other", post.type); if (type === null) return;
      try { await api(`/api/community/posts/${post.id}`, { method: "PUT", body: JSON.stringify({ title, text, type }) }); await loadCommunityFeed(prefix); } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); }
    }));
    feed.querySelectorAll("[data-community-comment]").forEach(form => form.addEventListener("submit", async event => { event.preventDefault(); const text = new FormData(form).get("text"); try { await api(`/api/community/posts/${form.dataset.communityComment}/comments`, { method: "POST", body: JSON.stringify({ text }) }); await loadCommunityFeed(prefix); } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); } }));
    feed.querySelectorAll("[data-community-reply]").forEach(form => form.addEventListener("submit", async event => { event.preventDefault(); const text = new FormData(form).get("text"); try { await api(`/api/community/posts/${form.closest("[data-post-id]").dataset.postId}/comments/${form.dataset.communityReply}/replies`, { method: "POST", body: JSON.stringify({ text }) }); await loadCommunityFeed(prefix); } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); } }));
  } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); }
}
async function submitCommunityPost(event, prefix) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const files = [...(form.elements.attachments.files || [])];
  if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) { showMessage(document.getElementById(`${prefix}CommunityMessage`), "Attach up to ten files with a combined size no larger than 50 MB."); return; }
  try {
    const attachments = await Promise.all(files.map(file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, data: reader.result }); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file); })));
    await api("/api/community/posts", { method: "POST", body: JSON.stringify({ type: data.get("type"), title: data.get("title"), text: data.get("text"), attachments }) });
    form.reset(); showMessage(document.getElementById(`${prefix}CommunityMessage`), "Post published to all users.", "success"); await loadCommunityFeed(prefix);
  } catch (error) { showMessage(document.getElementById(`${prefix}CommunityMessage`), error.message); }
}
document.getElementById("userCommunityForm").addEventListener("submit", event => submitCommunityPost(event, "user"));
document.getElementById("adminCommunityForm").addEventListener("submit", event => submitCommunityPost(event, "admin"));
function formatWeekCommencing(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value || "Unknown week";
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
async function downloadReportPdf(report) {
  const pageWidth = 842; const pageHeight = 595; const scale = 2; const margin = 31; const tableWidths = [156, 112, 90, 150, 140, 132];
  const encoder = new TextEncoder(); const pages = []; let canvas; let ctx; let y;
  const logo = new Image(); logo.src = "/Camfed(1).png"; await logo.decode();
  const fullName = report.author?.fullName || report.staff.fullName || "User";
  const email = report.author?.email || (signedInUser?.id === report.userId ? signedInUser.email : "");
  const department = report.author?.department || report.staff.department || "";
  const week = report.staff.weekCommencing || "";
  const bottom = pageHeight - 30;
  function newPage(first = false) {
    canvas = document.createElement("canvas"); canvas.width = pageWidth * scale; canvas.height = pageHeight * scale;
    pages.push(canvas); ctx = canvas.getContext("2d"); ctx.scale(scale, scale); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, pageWidth, pageHeight);
    const logoWidth = first ? 190 : 125; const logoHeight = logoWidth * logo.height / logo.width;
    ctx.drawImage(logo, (pageWidth - logoWidth) / 2, 12, logoWidth, logoHeight);
    const ruleY = 12 + logoHeight + 8;
    ctx.fillStyle = "#16834a"; ctx.fillRect(margin, ruleY, (pageWidth - margin * 2) / 3, 3);
    ctx.fillStyle = "#11683b"; ctx.fillRect(margin + (pageWidth - margin * 2) / 3, ruleY, (pageWidth - margin * 2) / 3, 3);
    ctx.fillStyle = "#5a2674"; ctx.fillRect(margin + (pageWidth - margin * 2) * 2 / 3, ruleY, (pageWidth - margin * 2) / 3, 3);
    y = ruleY + 13;
    if (first) {
      ctx.fillStyle = "#f7f3f8"; ctx.fillRect(margin, y, pageWidth - margin * 2, 57);
      ctx.strokeStyle = "#e6dce9"; ctx.strokeRect(margin, y, pageWidth - margin * 2, 57);
      ctx.fillStyle = "#5a2674"; ctx.font = "bold 9px Arial"; ctx.fillText("USER DETAILS", margin + 10, y + 7);
      ctx.fillStyle = "#2b1714"; ctx.font = "9px Arial";
      ctx.fillText(`Full name: ${fullName}`, margin + 10, y + 22);
      ctx.fillText(`Email: ${email || "—"}`, margin + 275, y + 22);
      ctx.fillText(`Department: ${department || "—"}`, margin + 10, y + 39);
      ctx.fillText(`Position: ${report.staff.designation || "—"}`, margin + 275, y + 39);
      ctx.fillText(`Week commencing: ${week}`, margin + 565, y + 39);
      y += 70;
    } else {
      ctx.fillStyle = "#2b1714"; ctx.font = "bold 9px Arial"; ctx.fillText(`${fullName} · Week commencing ${week}`, margin, y); y += 18;
    }
  }
  function wrapText(value, maxWidth, font) {
    ctx.font = font; const result = [];
    for (const paragraph of String(value || "—").split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean); let line = "";
      if (!words.length) { result.push(""); continue; }
      for (let word of words) {
        while (ctx.measureText(word).width > maxWidth) {
          let part = "";
          while (word && ctx.measureText(part + word[0]).width <= maxWidth) { part += word[0]; word = word.slice(1); }
          if (!part && word) { part = word[0]; word = word.slice(1); }
          if (line) { result.push(line); line = ""; }
          if (part) result.push(part);
        }
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width > maxWidth && line) { result.push(line); line = word; }
        else line = candidate;
      }
      if (line) result.push(line);
    }
    return result.length ? result : [""];
  }
  function drawDayHeading(day, status) {
    ctx.fillStyle = "#f2eaf5"; ctx.fillRect(margin, y, pageWidth - margin * 2, 22);
    ctx.fillStyle = "#512469"; ctx.font = "bold 10px Arial"; ctx.fillText(`${day}${status ? ` · ${status}` : ""}`, margin + 8, y + 6); y += 22;
  }
  function drawColumnHeadings() {
    let x = margin; ctx.font = "bold 8px Arial"; ctx.fillStyle = "#16834a";
    for (let i = 0; i < reportColumns.length; i++) {
      ctx.fillRect(x, y, tableWidths[i], 22); ctx.fillStyle = "#ffffff"; ctx.fillText(reportColumns[i][1], x + 5, y + 7); ctx.fillStyle = "#16834a"; x += tableWidths[i];
    }
    y += 22;
  }
  function drawDayTable(item, index) {
    const day = item.day || days[index] || "Day";
    const cells = reportColumns.map(([key]) => wrapText(item[key] ?? (key === "activity" ? item.activity : "") ?? "", tableWidths[reportColumns.findIndex(column => column[0] === key)] - 12, "8px Arial"));
    const maxLines = Math.max(1, ...cells.map(lines => lines.length)); let offset = 0;
    while (offset < maxLines) {
      if (y + 60 > bottom) newPage(false);
      drawDayHeading(day, item.status);
      drawColumnHeadings();
      const lineHeight = 10; const available = Math.max(1, Math.floor((bottom - y - 8) / lineHeight));
      const count = Math.min(available, maxLines - offset); const rowHeight = count * lineHeight + 12;
      let x = margin;
      for (let i = 0; i < tableWidths.length; i++) {
        ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, tableWidths[i], rowHeight); ctx.strokeStyle = "#d9d3da"; ctx.strokeRect(x, y, tableWidths[i], rowHeight);
        ctx.fillStyle = "#2b1714"; ctx.font = "8px Arial";
        cells[i].slice(offset, offset + count).forEach((line, lineIndex) => ctx.fillText(line, x + 5, y + 6 + lineIndex * lineHeight, tableWidths[i] - 10));
        x += tableWidths[i];
      }
      y += rowHeight + 12; offset += count;
      if (offset < maxLines) newPage(false);
    }
  }
  function drawFeedbackBlock(title, body, indent = 0) {
    const left = margin + indent; const textWidth = pageWidth - margin * 2 - indent - 12; const lines = wrapText(body, textWidth, "8.5px Arial");
    let offset = 0; let titlePending = true;
    while (offset < lines.length) {
      if (y + 35 > bottom) newPage(false);
      if (titlePending) { ctx.fillStyle = "#512469"; ctx.font = "bold 9px Arial"; ctx.fillText(title, left, y); y += 13; titlePending = false; }
      const available = Math.max(1, Math.floor((bottom - y - 5) / 11)); const count = Math.min(available, lines.length - offset);
      ctx.fillStyle = "#2b1714"; ctx.font = "8.5px Arial";
      lines.slice(offset, offset + count).forEach((line, i) => ctx.fillText(line, left, y + i * 11));
      y += count * 11 + 8; offset += count;
      if (offset < lines.length) newPage(false);
    }
  }
  newPage(true);
  for (let index = 0; index < report.activities.length; index++) drawDayTable(report.activities[index], index);
  if (report.feedback?.length) {
    if (y + 26 > bottom) newPage(false);
    ctx.fillStyle = "#512469"; ctx.font = "bold 13px Arial"; ctx.fillText("LINE MANAGER FEEDBACK AND USER REPLIES", margin, y); y += 20;
    for (const feedback of report.feedback) {
      const sent = feedback.sentAt ? `Sent ${new Date(feedback.sentAt).toLocaleString()}` : "Draft · not sent";
      drawFeedbackBlock(`Line Manager · ${sent}`, feedback.text);
      for (const reply of feedback.replies || []) drawFeedbackBlock(`User reply · ${new Date(reply.createdAt).toLocaleString()}`, reply.text, 16);
    }
  }
  const objects = 2 + pages.length * 3; const chunks = []; let byteOffset = 0; const offsets = new Array(objects + 1).fill(0);
  function pushBytes(bytes) { chunks.push(bytes); byteOffset += bytes.length; }
  function pushText(text) { pushBytes(encoder.encode(text)); }
  function startObject(id) { offsets[id] = byteOffset; pushText(`${id} 0 obj\n`); }
  function endObject() { pushText("\nendobj\n"); }
  pushText("%PDF-1.4\n");
  startObject(1); pushText("<< /Type /Catalog /Pages 2 0 R >>"); endObject();
  const pageIds = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  startObject(2); pushText(`<< /Type /Pages /Kids [${pageIds}] /Count ${pages.length} >>`); endObject();
  for (let index = 0; index < pages.length; index++) {
    const pageId = 3 + index * 3; const contentId = pageId + 1; const imageId = pageId + 2;
    startObject(pageId); pushText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`); endObject();
    const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
    startObject(contentId); pushText(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`); endObject();
    const jpegData = pages[index].toDataURL("image/jpeg", 0.94).split(",")[1]; const jpeg = Uint8Array.from(atob(jpegData), char => char.charCodeAt(0));
    startObject(imageId); pushText(`<< /Type /XObject /Subtype /Image /Width ${pageWidth * scale} /Height ${pageHeight * scale} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); pushBytes(jpeg); pushText("\nendstream"); endObject();
  }
  const xrefOffset = byteOffset; pushText(`xref\n0 ${objects + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objects; id++) pushText(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  pushText(`trailer\n<< /Size ${objects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const pdf = new Blob(chunks, { type: "application/pdf" }); const url = URL.createObjectURL(pdf); const link = document.createElement("a");
  const safeName = fullName.normalize("NFKD").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "User";
  link.href = url; link.download = `CAMFED_Weekly_Activity_Report_${safeName}_${week}.pdf`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById("createUserForm").addEventListener("submit", async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  data.email = String(data.email || "").trim(); data.department = String(data.department || "").trim();
  try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(data) }); event.currentTarget.reset(); showMessage(document.getElementById("adminMessage"), "User account created.", "success"); await loadUsers(); }
  catch (error) { showMessage(document.getElementById("adminMessage"), error.message); }
});

async function loadManagerReports(usersListId = "managerUsers", containerId = "managerReports", headingId = "selectedUserHeading", messageId = "managerMessage", selectedUserId = "") {
  const usersList = document.getElementById(usersListId);
  const container = document.getElementById(containerId);
  try {
    const { assignedUsers, reports } = await api("/api/manager/reports");
    if (!assignedUsers.some(item => item.id === selectedUserId)) selectedUserId = "";
    usersList.innerHTML = assignedUsers.map(item => `<button type="button" class="manager-user-link${item.id === selectedUserId ? " is-selected" : ""}" data-manager-user="${escapeHtml(item.id)}">${escapeHtml(item.fullName)}</button>`).join("") || '<p class="empty-reports">No users are currently assigned to you.</p>';
    usersList.querySelectorAll("[data-manager-user]").forEach(button => button.addEventListener("click", () => loadManagerReports(usersListId, containerId, headingId, messageId, button.dataset.managerUser)));
    renderSelectedManagerReports(selectedUserId, assignedUsers, reports, containerId, headingId, messageId, usersListId);
  } catch (error) { showMessage(document.getElementById(messageId), error.message); }
}

function lusakaToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lusaka", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}`;
}
function deadlineState(deadline, completed = false) {
  if (completed) return "Completed";
  const today = lusakaToday();
  if (deadline < today) return "Overdue";
  const daysLeft = (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  return daysLeft <= 3 ? "Due soon" : "Upcoming";
}
function activityUpdatesMarkup(updates) {
  return updates?.length ? updates.slice().reverse().map(update => `<p class="activity-update"><strong>${escapeHtml(update.authorName)} · ${escapeHtml(update.status)}</strong><small>${escapeHtml(new Date(update.createdAt).toLocaleString())}</small><br>${escapeHtml(update.text)}</p>`).join("") : '<p class="empty-reports">No progress updates yet.</p>';
}
async function loadMyActivities() {
  const container = document.getElementById("myActivities");
  try {
    const { activities } = await api("/api/my/activities");
    updateActivityNotification(activities);
    container.innerHTML = activities.map(activity => {
      const state = deadlineState(activity.deadline, activity.status === "Completed");
      return `<article class="manager-report-card activity-card"><header><div><h3>${escapeHtml(activity.title)}</h3><p>Deadline ${escapeHtml(activity.deadline)} · ${escapeHtml(activity.status)} · ${state}</p></div><span class="report-date">Assigned ${escapeHtml(new Date(activity.createdAt).toLocaleDateString())}</span></header><details class="activity-edit-details"><summary>Edit activity details</summary><form class="activity-edit-form" data-update-activity="${escapeHtml(activity.id)}"><label>Activity title<input name="title" maxlength="200" value="${escapeHtml(activity.title)}" required></label><label>Instructions<textarea name="description" maxlength="5000" required>${escapeHtml(activity.description)}</textarea></label><label>Deadline<input name="deadline" type="date" value="${escapeHtml(activity.deadline)}" required></label><fieldset><legend>Assigned users</legend><div class="assignee-options">${assignedUsers.map(person => `<label class="assignee-option"><input type="checkbox" name="assigneeIds" value="${escapeHtml(person.id)}" ${activity.assigneeIds.includes(person.id) ? "checked" : ""}>${escapeHtml(person.fullName)} <span>${escapeHtml(person.email)}</span></label>`).join("")}</div></fieldset><input type="hidden" name="previousDeadline" value="${escapeHtml(activity.deadline)}"><button class="btn btn-secondary" type="submit">Save activity changes</button></form></details><p class="activity-description">${escapeHtml(activity.description)}</p><div class="activity-updates">${activityUpdatesMarkup(activity.updates)}</div><label>Progress update<textarea data-activity-update="${escapeHtml(activity.id)}" maxlength="5000" placeholder="Share progress or explain a delay..."></textarea></label><div class="activity-update-controls"><label>Status<select data-activity-status="${escapeHtml(activity.id)}"><option${activity.status === "Not Started" ? " selected" : ""}>Not Started</option><option${activity.status === "In Progress" ? " selected" : ""}>In Progress</option><option${activity.status === "On Hold" ? " selected" : ""}>On Hold</option><option${activity.status === "Completed" ? " selected" : ""}>Completed</option></select></label><button type="button" class="btn btn-secondary" data-save-activity="${escapeHtml(activity.id)}">Send update</button></div></article>`;
    }).join("") || '<p class="empty-reports">No activities have been assigned to you.</p>';
    container.querySelectorAll("[data-save-activity]").forEach(button => button.addEventListener("click", async () => {
      const id = button.dataset.saveActivity; const field = container.querySelector(`[data-activity-update="${id}"]`); const status = container.querySelector(`[data-activity-status="${id}"]`).value;
      try { await api(`/api/my/activities/${id}/updates`, { method: "POST", body: JSON.stringify({ text: field.value, status }) }); showMessage(document.getElementById("myActivitiesMessage"), "Progress update sent to your Line Manager.", "success"); await loadMyActivities(); }
      catch (error) { showMessage(document.getElementById("myActivitiesMessage"), error.message); }
    }));
  } catch (error) { showMessage(document.getElementById("myActivitiesMessage"), error.message); }
}
document.getElementById("my-activities-heading").closest("section").addEventListener("click", markActivityNotificationsSeen);
async function loadManagerActivities(prefix) {
  const admin = prefix === "admin"; const form = document.getElementById(admin ? "adminActivityForm" : "managerActivityForm");
  const usersNode = document.getElementById(admin ? "adminActivityAssignees" : "managerActivityAssignees");
  const list = document.getElementById(admin ? "adminActivities" : "managerActivities");
  const messageNode = document.getElementById(admin ? "adminActivityMessage" : "managerActivityMessage");
  try {
    const { assignedUsers, activities } = await api("/api/manager/activities");
    usersNode.innerHTML = assignedUsers.map(person => `<label class="assignee-option"><input type="checkbox" name="assigneeIds" value="${escapeHtml(person.id)}">${escapeHtml(person.fullName)} <span>${escapeHtml(person.email)}</span></label>`).join("") || '<p class="empty-reports">No users are currently assigned to you.</p>';
    list.innerHTML = activities.slice().reverse().map(activity => `<article class="manager-report-card activity-card"><header><div><h3>${escapeHtml(activity.title)}</h3><p>Deadline ${escapeHtml(activity.deadline)} · Assigned to ${activity.assignees.map(item => escapeHtml(item.fullName)).join(", ")}</p></div><span class="report-date">Created ${escapeHtml(new Date(activity.createdAt).toLocaleDateString())}</span></header><p class="activity-description">${escapeHtml(activity.description)}</p>${activity.assignees.map(person => { const updates = activity.updates.filter(update => update.authorId === person.id || update.recipientId === person.id); const status = activity.statusByUser?.[person.id] || "Not Started"; return `<div class="assignee-progress"><h4>${escapeHtml(person.fullName)} · ${escapeHtml(status)} · ${deadlineState(activity.deadline, status === "Completed")}</h4>${activityUpdatesMarkup(updates)}<div class="activity-reply-controls"><label>Reply to ${escapeHtml(person.fullName)}<textarea data-manager-reply="${escapeHtml(activity.id)}-${escapeHtml(person.id)}" maxlength="5000" placeholder="Write a reply..."></textarea></label><button type="button" class="btn btn-secondary" data-send-manager-reply="${escapeHtml(activity.id)}" data-reply-user="${escapeHtml(person.id)}">Send reply</button></div></div>`; }).join("")}</article>`).join("") || '<p class="empty-reports">No activities created yet.</p>';
    list.querySelectorAll("[data-update-activity]").forEach(editForm => editForm.addEventListener("submit", async event => {
      event.preventDefault(); const data = new FormData(editForm); const activityId = editForm.dataset.updateActivity;
      try { const result = await api("/api/manager/activities/" + encodeURIComponent(activityId), { method: "PUT", body: JSON.stringify({ title: data.get("title"), description: data.get("description"), deadline: data.get("deadline"), previousDeadline: data.get("previousDeadline"), assigneeIds: data.getAll("assigneeIds") }) }); showMessage(messageNode, result.changed === false ? "No activity details changed." : "Activity updated. Affected users have been notified.", "success"); await loadManagerActivities(prefix); }
      catch (error) { showMessage(messageNode, error.message); }
    }));
    list.querySelectorAll("[data-send-manager-reply]").forEach(button => button.addEventListener("click", async () => {
      const activityId = button.dataset.sendManagerReply; const userId = button.dataset.replyUser; const field = list.querySelector(`[data-manager-reply="${activityId}-${userId}"]`);
      try { await api(`/api/manager/activities/${activityId}/assignees/${userId}/replies`, { method: "POST", body: JSON.stringify({ text: field.value }) }); showMessage(messageNode, "Reply sent to the user.", "success"); await loadManagerActivities(prefix); }
      catch (error) { showMessage(messageNode, error.message); }
    }));
    form.onsubmit = async event => {
      event.preventDefault(); const data = new FormData(form); const assigneeIds = data.getAll("assigneeIds");
      try { await api("/api/manager/activities", { method: "POST", body: JSON.stringify({ title: data.get("title"), description: data.get("description"), deadline: data.get("deadline"), assigneeIds }) }); form.reset(); showMessage(messageNode, "Activity assigned successfully.", "success"); await loadManagerActivities(prefix); }
      catch (error) { showMessage(messageNode, error.message); }
    };
  } catch (error) { showMessage(messageNode, error.message); }
}

function renderSelectedManagerReports(selectedUserId, assignedUsers, reports, containerId, headingId, messageId, usersListId) {
  const container = document.getElementById(containerId);
  const heading = document.getElementById(headingId);
  const selectedUser = assignedUsers.find(item => item.id === selectedUserId);
  heading.textContent = selectedUser ? `${selectedUser.fullName}'s submitted reports` : "Select a user to review their reports.";
  container.innerHTML = selectedUser ? reports.filter(report => report.userId === selectedUserId).map(report => `<article class="manager-report-card">
      <header><div><h3>${escapeHtml(report.author?.fullName || report.staff.fullName)} <span>(${escapeHtml(report.author?.email || "Account removed")})</span></h3><p>${escapeHtml(report.author?.department || report.staff.department)} · Week commencing ${escapeHtml(report.staff.weekCommencing)}</p></div><span class="report-date">Submitted ${escapeHtml(new Date(report.submittedAt).toLocaleString())}</span></header>
      <div class="review-activities">${renderReportDays(report.activities)}</div>
      <div class="report-comments"><h4>Feedback and replies</h4>${(report.feedback || []).map(feedback => `<div class="feedback-thread"><p class="report-comment"><strong>${escapeHtml(feedback.authorName)}</strong> · ${escapeHtml(new Date(feedback.createdAt).toLocaleString())} · ${feedback.sentAt ? "Sent to user" : "Draft"}<br>${escapeHtml(feedback.text)}</p>${(feedback.replies || []).map(reply => `<p class="feedback-reply"><strong>Reply from ${escapeHtml(reply.authorName)}</strong> · ${escapeHtml(new Date(reply.createdAt).toLocaleString())}<br>${escapeHtml(reply.text)}</p>`).join("")}${feedback.sentAt ? "" : `<button type="button" class="btn btn-primary" data-send-feedback="${escapeHtml(report.id)}" data-feedback-id="${escapeHtml(feedback.id)}">Send feedback to user</button>`}</div>`).join("") || '<p class="empty-comments">No feedback drafted yet.</p>'}</div>
      <label>New feedback<textarea data-feedback-draft="${escapeHtml(report.id)}" maxlength="5000" placeholder="Write feedback for this report..."></textarea></label><button type="button" class="btn btn-secondary" data-create-feedback="${escapeHtml(report.id)}">Save feedback draft</button>
      <button type="button" class="btn btn-secondary" data-download-report="${escapeHtml(report.id)}">Download PDF</button>
    </article>`).join("") : "";
  if (selectedUser && !reports.some(report => report.userId === selectedUserId)) container.innerHTML = '<p class="empty-reports">This user has not submitted any weekly reports yet.</p>';
    container.querySelectorAll("[data-create-feedback]").forEach(button => button.addEventListener("click", async () => {
      const reportId = button.dataset.createFeedback; const field = container.querySelector(`[data-feedback-draft="${reportId}"]`);
      try { await api(`/api/manager/reports/${reportId}/feedback`, { method: "POST", body: JSON.stringify({ feedback: field.value }) }); showMessage(document.getElementById(messageId), "Feedback draft saved. Send it when it is ready.", "success"); await loadManagerReports(usersListId, containerId, headingId, messageId, selectedUserId); }
      catch (error) { showMessage(document.getElementById(messageId), error.message); }
    }));
    container.querySelectorAll("[data-send-feedback]").forEach(button => button.addEventListener("click", async () => {
      const reportId = button.dataset.sendFeedback; const feedbackId = button.dataset.feedbackId;
      try { await api(`/api/manager/reports/${reportId}/feedback/${feedbackId}/send`, { method: "POST", body: "{}" }); showMessage(document.getElementById(messageId), "Feedback sent to the user.", "success"); await loadManagerReports(usersListId, containerId, headingId, messageId, selectedUserId); }
      catch (error) { showMessage(document.getElementById(messageId), error.message); }
    }));
    container.querySelectorAll("[data-download-report]").forEach(button => button.addEventListener("click", async () => {
      const report = reports.find(item => item.id === button.dataset.downloadReport);
      try { await downloadReportPdf(report); showMessage(document.getElementById(messageId), "PDF report downloaded.", "success"); }
      catch (error) { showMessage(document.getElementById(messageId), `Could not create the PDF: ${error.message}`); }
    }));
}

async function loadMyReports() {
  const container = document.getElementById("myReports");
  try {
    const { reports } = await api("/api/my/reports");
    reports.sort((a, b) => String(b.staff.weekCommencing).localeCompare(String(a.staff.weekCommencing)) || String(b.submittedAt).localeCompare(String(a.submittedAt)));
    container.innerHTML = reports.map(report => `<details class="manager-report-card submitted-report-card"><summary><span><strong>Week Commencing: ${escapeHtml(formatWeekCommencing(report.staff.weekCommencing))}</strong><small>Submitted ${escapeHtml(new Date(report.submittedAt).toLocaleString())}</small></span><span class="report-open-hint">View report</span></summary><div class="submitted-report-content"><div class="review-activities">${renderReportDays(report.activities)}</div><div class="report-comments"><h4>Line Manager feedback</h4>${(report.feedback || []).map(feedback => `<div class="feedback-thread"><p class="report-comment"><strong>${escapeHtml(feedback.authorName)}</strong> · ${escapeHtml(new Date(feedback.sentAt).toLocaleString())}<br>${escapeHtml(feedback.text)}</p>${(feedback.replies || []).map(reply => `<p class="feedback-reply"><strong>Your reply</strong> · ${escapeHtml(new Date(reply.createdAt).toLocaleString())}<br>${escapeHtml(reply.text)}</p>`).join("")}<label>Reply<textarea data-reply-text="${escapeHtml(feedback.id)}" maxlength="5000" placeholder="Reply to this feedback..."></textarea></label><button type="button" class="btn btn-secondary" data-reply-report="${escapeHtml(report.id)}" data-reply-feedback="${escapeHtml(feedback.id)}">Send reply</button></div>`).join("") || '<p class="empty-comments">No feedback yet.</p>'}</div><button type="button" class="btn btn-secondary" data-download-report="${escapeHtml(report.id)}">Download PDF</button></div></details>`).join("") || '<p class="empty-reports">You have not submitted any weekly reports yet.</p>';
    container.querySelectorAll("[data-reply-report]").forEach(button => button.addEventListener("click", async () => {
      const reportId = button.dataset.replyReport; const feedbackId = button.dataset.replyFeedback; const field = container.querySelector(`[data-reply-text="${feedbackId}"]`);
      try { await api(`/api/my/reports/${reportId}/feedback/${feedbackId}/replies`, { method: "POST", body: JSON.stringify({ reply: field.value }) }); showMessage(document.getElementById("myReportsMessage"), "Reply sent to your Line Manager.", "success"); await loadMyReports(); }
      catch (error) { showMessage(document.getElementById("myReportsMessage"), error.message); }
    }));
    container.querySelectorAll("[data-download-report]").forEach(button => button.addEventListener("click", async () => {
      const report = reports.find(item => item.id === button.dataset.downloadReport);
      try { await downloadReportPdf(report); showMessage(document.getElementById("myReportsMessage"), "PDF report downloaded.", "success"); }
      catch (error) { showMessage(document.getElementById("myReportsMessage"), `Could not create the PDF: ${error.message}`); }
    }));
  } catch (error) { showMessage(document.getElementById("myReportsMessage"), error.message); }
}

let draftSaveQueue = Promise.resolve();
function draftFields() {
  const fields = {};
  for (const control of form.elements) if (control.name && control.name !== "weekCommencing") fields[control.name] = control.value;
  return fields;
}
function scheduleDraftSave() {
  if (loadingDraft || !draftWeek) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => saveReportDraft(draftWeek, draftFields()), 500);
}
function saveReportDraft(week, fields) {
  if (!week) return Promise.resolve();
  const status = document.getElementById("draftSaveStatus");
  status.textContent = "Saving your progress…";
  draftSaveQueue = draftSaveQueue.catch(() => {}).then(() => api("/api/my/draft", { method: "PUT", body: JSON.stringify({ weekCommencing: week, fields }) }));
  return draftSaveQueue.then(() => { if (week === draftWeek) status.textContent = "Progress saved automatically."; }).catch(error => { if (week === draftWeek) status.textContent = `Could not save progress: ${error.message}`; });
}
async function loadReportDraft(week) {
  if (!week) return;
  loadingDraft = true;
  try {
    const { draft } = await api(`/api/my/draft?week=${encodeURIComponent(week)}`);
    form.reset();
    document.getElementById("weekCommencing").value = week;
    if (draft?.fields) for (const [name, value] of Object.entries(draft.fields)) if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
    applyPublicHolidayLocks(week);
    document.getElementById("draftSaveStatus").textContent = draft ? `Saved progress restored (${new Date(draft.updatedAt).toLocaleString()}).` : "Your progress saves automatically as you type.";
  } catch (error) {
    document.getElementById("draftSaveStatus").textContent = `Could not restore saved progress: ${error.message}`;
  } finally { loadingDraft = false; }
}
function startReportDraft() {
  draftWeek = document.getElementById("weekCommencing").value;
  refreshPublicHolidays().then(() => loadReportDraft(draftWeek)).catch(error => { document.getElementById("draftSaveStatus").textContent = `Could not load public holiday dates: ${error.message}`; loadReportDraft(draftWeek); });
}
renderDays();
async function handleProfilePictureChange(event, display) {
 const input=event.currentTarget,file=input.files?.[0];if(!file)return;
 if(!["image/png","image/jpeg","image/webp"].includes(file.type)){showMessage(loginMessage,"Choose a PNG, JPEG, or WebP image.");input.value="";return;}
 if(file.size>30*1024*1024){showMessage(loginMessage,"The image must be 30 MB or smaller.");input.value="";return;}
 try{const picture=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("Could not read the selected image."));reader.readAsDataURL(file);});await api("/api/my/profile-picture",{method:"PUT",body:JSON.stringify({picture})});display(picture);}catch(error){showMessage(loginMessage,"Could not save photo: "+error.message);}input.value="";
}
document.getElementById("sharedProfilePictureInput").addEventListener("change",event=>handleProfilePictureChange(event,displayProfilePicture));
document.getElementById("holidayForm").addEventListener("submit", async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api("/api/admin/holidays", { method: "POST", body: JSON.stringify(data) }); event.currentTarget.reset(); showMessage(document.getElementById("holidayMessage"), "Public holiday added.", "success"); await loadHolidayAdmin(); await refreshPublicHolidays(); }
  catch (error) { showMessage(document.getElementById("holidayMessage"), error.message); }
});
form.addEventListener("input", scheduleDraftSave);
form.addEventListener("change", event => {
  if (event.target.id !== "weekCommencing") return;
  clearTimeout(draftSaveTimer);
  const previousWeek = draftWeek;
  const previousSave = saveReportDraft(previousWeek, draftFields());
  draftWeek = event.target.value;
  previousSave.finally(async () => { try { await refreshPublicHolidays(); await loadReportDraft(draftWeek); } catch (error) { document.getElementById("draftSaveStatus").textContent = `Could not update public holiday dates: ${error.message}`; } });
});
form.addEventListener("submit", async event => {
  event.preventDefault(); message.className = "form-message"; message.textContent = ""; if (!form.reportValidity()) return;
  if (new Date(`${document.getElementById("weekCommencing").value}T00:00:00Z`).getUTCDay() !== 1) { showMessage(message, "Select a Monday as the week commencing date."); return; }
  const data = new FormData(form);
  const report = { staff: { weekCommencing: data.get("weekCommencing") }, activities: days.map((day, index) => {
    const prefix = day.toLowerCase();
    const isHoliday = publicHolidayMap.has(weekdayDate(data.get("weekCommencing"), index));
    return { day, status: isHoliday ? "Not Applicable" : data.get(`status-${prefix}`), ...Object.fromEntries(reportColumns.map(([key]) => [key, isHoliday ? "" : String(data.get(`${prefix}-${key}`) || "").trim()])) };
  }) };
  try { await api("/api/reports", { method: "POST", body: JSON.stringify(report) }); clearTimeout(draftSaveTimer); await draftSaveQueue.catch(() => {}); await api(`/api/my/draft?week=${encodeURIComponent(report.staff.weekCommencing)}`, { method: "DELETE" }); showMessage(message, "Your weekly report was submitted and saved.", "success"); document.getElementById("draftSaveStatus").textContent = "Submitted report saved."; message.scrollIntoView({ behavior: "smooth", block: "nearest" }); await loadMyReports(); }
  catch (error) { showMessage(message, error.message); }
});
form.addEventListener("reset", () => { message.className = "form-message"; message.textContent = ""; });
setInterval(() => { if (signedInUser) { document.getElementById("globalCurrentDate").textContent = currentPortalDate(); document.getElementById("globalCurrentDate").dateTime = new Date().toISOString().slice(0,10); } if (activeDashboard === "weekly") refreshPublicHolidays().catch(() => {}); else if (activeDashboard === "assigned") loadMyActivities(); else if (activeDashboard === "community") loadCommunityFeed(signedInUser?.role === "admin" ? "admin" : "user"); else if (activeDashboard === "manager-activities") loadManagerActivities(signedInUser?.role === "admin" ? "admin" : "user"); }, 60000);
(async () => { try { const { user } = await api("/api/session"); if (user) { showDashboard(user); openDashboardFromNotificationLink(); } else showLogin(); } catch { showLogin(); } })();
