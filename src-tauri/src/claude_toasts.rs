#[cfg(windows)]
use std::cell::RefCell;
use std::collections::HashSet;
#[cfg(windows)]
use windows::core::Result;
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
#[cfg(windows)]
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
#[cfg(windows)]
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};

#[cfg(windows)]
thread_local! {
    static LISTENER: RefCell<Option<Option<UserNotificationListener>>> = RefCell::new(None);
}

// ponytail: Unpackaged apps may be denied listener access on some Windows builds;
// packaging with the userNotificationListener capability is the upgrade path.
#[cfg(windows)]
pub fn poll_new(seen: &mut HashSet<u32>) -> Vec<(u32, String, String)> {
    LISTENER.with(|state| {
        let mut state = state.borrow_mut();
        if state.is_none() {
            let listener = (|| {
                unsafe {
                    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
                }
                let listener = UserNotificationListener::Current().ok()?;
                if listener.RequestAccessAsync().ok()?.get().ok()?
                    != UserNotificationListenerAccessStatus::Allowed
                {
                    return None;
                }
                Some(listener)
            })();
            *state = Some(listener);
        }
        let Some(Some(listener)) = state.as_ref() else {
            return Vec::new();
        };
        if listener.GetAccessStatus().ok() != Some(UserNotificationListenerAccessStatus::Allowed) {
            *state = Some(None);
            return Vec::new();
        }
        match read_toasts(listener, seen) {
            Ok(toasts) => toasts,
            Err(_) => {
                *state = Some(None);
                Vec::new()
            }
        }
    })
}

#[cfg(not(windows))]
pub fn poll_new(_seen: &mut HashSet<u32>) -> Vec<(u32, String, String)> {
    Vec::new()
}

#[cfg(windows)]
fn read_toasts(
    listener: &UserNotificationListener,
    seen: &mut HashSet<u32>,
) -> Result<Vec<(u32, String, String)>> {
    let notifications = listener.GetNotificationsAsync(NotificationKinds::Toast)?.get()?;
    let mut current = HashSet::new();
    let mut new = Vec::new();
    for index in 0..notifications.Size()? {
        let notification = notifications.GetAt(index)?;
        let id = notification.Id()?;
        current.insert(id);
        if seen.contains(&id) {
            continue;
        }
        let app_name = notification.AppInfo()?.DisplayInfo()?.DisplayName()?.to_string();
        seen.insert(id);
        if !app_name.to_lowercase().contains("claude") {
            continue;
        }
        let binding = notification
            .Notification()?
            .Visual()?
            .GetBinding(&KnownNotificationBindings::ToastGeneric()?)?;
        let elements = binding.GetTextElements()?;
        let mut lines = Vec::new();
        for index in 0..elements.Size()? {
            lines.push(elements.GetAt(index)?.Text()?.to_string());
        }
        let title = lines.first().cloned().unwrap_or_default();
        let body = lines.into_iter().skip(1).collect::<Vec<_>>().join("\n");
        new.push((id, title, body));
    }
    seen.retain(|id| current.contains(id));
    Ok(new)
}
