// Polaris Alpha: PWA с Leaflet + Overpass для поиска ближайшего общепита в ЮВА
// Без Google API. Использует OSM-данные (amenity=...).

let map;
let userMarker = null;
let renderObjects = []; // маркеры/линии найденных мест

// Центр по умолчанию (Бангкок), чтобы было релевантно ЮВА до определения геолокации
const DEFAULT_CENTER = { lat: 13.7563, lng: 100.5018 };
const DEFAULT_ZOOM = 13;

// Типы общепита (OSM amenity)
const AMENITY_TYPES = {
  restaurant: ["restaurant"],
  cafe: ["cafe"],
  fast_food: ["fast_food"],
  bar: ["bar"],
  pub: ["pub"],
  food_court: ["food_court"],
  biergarten: ["biergarten"],
  all: [
    "restaurant",
    "cafe",
    "fast_food",
    "bar",
    "pub",
    "food_court",
    "biergarten"
  ]
};

// Инициализация после загрузки DOM
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initUI();
  registerServiceWorker();
});

// Инициализация карты Leaflet
function initMap() {
  map = L.map("map").setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);

  // OSM тайлы (публичный сервер, только для легкого использования; для продакшена лучше свой/провайдер)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
}

// Инициализация UI
function initUI() {
  const findBtn = document.getElementById("findBtn");
  findBtn.addEventListener("click", onFindClick);
}

// Обработка клика "Найти ближайшее заведение"
function onFindClick() {
  if (!navigator.geolocation) {
    setStatus("Геолокация не поддерживается вашим браузером.", true);
    return;
  }

  const amenityKey = document.getElementById("placeType").value;
  const onlyName = document.getElementById("onlyName").checked;
  let radius = parseInt(document.getElementById("radius").value, 10);

  if (isNaN(radius) || radius < 100) radius = 100;
  if (radius > 5000) radius = 5000;

  const amenities = AMENITY_TYPES[amenityKey] || AMENITY_TYPES.all;

  setStatus("Определяем ваше местоположение...");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const userLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude
      };

      showUserLocation(userLocation);

      setStatus(
        "Местоположение определено. Ищем заведения поблизости (" +
          radius +
          " м)..."
      );

      searchNearestWithOverpass({
        userLocation,
        amenities,
        radius,
        onlyName
      });
    },
    (err) => {
      console.error(err);
      if (err.code === err.PERMISSION_DENIED) {
        setStatus(
          "Доступ к геолокации запрещен. Разрешите доступ и попробуйте снова.",
          true
        );
      } else {
        setStatus("Не удалось получить геолокацию. Повторите попытку.", true);
      }
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

// Показать маркер пользователя
function showUserLocation(location) {
  if (userMarker) {
    userMarker.remove();
  }

  userMarker = L.circleMarker([location.lat, location.lng], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#1976d2",
    fillOpacity: 1
  }).addTo(map);

  map.setView([location.lat, location.lng], 16);
}

// Запрос к Overpass API
function searchNearestWithOverpass({ userLocation, amenities, radius, onlyName }) {
  clearRenderObjects();

  // Формируем регулярку по типам amenity
  const amenityRegex = amenities.join("|");

  // Overpass QL:
  // around:radius,lat,lon — поиск в радиусе
  // amenity~"..." — нужные типы
  let query = `
    [out:json][timeout:25];
    (
      node["amenity"~"${amenityRegex}"](around:${radius},${userLocation.lat},${userLocation.lng});
      way["amenity"~"${amenityRegex}"](around:${radius},${userLocation.lat},${userLocation.lng});
      relation["amenity"~"${amenityRegex}"](around:${radius},${userLocation.lat},${userLocation.lng});
    );
    out center;
  `;

  setStatus("Отправляем запрос к Overpass API...");

  // Публичный сервер Overpass. Для серьезных проектов — поднимайте свой.
  const url = "https://overpass-api.de/api/interpreter";

  fetch(url, {
    method: "POST",
    body: query,
    headers: {
      "Content-Type": "text/plain"
    }
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error("Ошибка Overpass: " + res.status);
      }
      return res.json();
    })
    .then((data) => {
      handleOverpassResponse(data, { userLocation, radius, onlyName });
    })
    .catch((err) => {
      console.error(err);
      setStatus(
        "Ошибка при запросе к Overpass API. Попробуйте еще раз позже.",
        true
      );
      setPlaceDetails(
        "Публичный Overpass-сервер мог быть перегружен. Для продакшена рекомендуется собственный сервер."
      );
    });
}

// Обработка ответа Overpass
function handleOverpassResponse(data, { userLocation, radius, onlyName }) {
  if (!data || !Array.isArray(data.elements)) {
    setStatus("Неверный ответ Overpass API.", true);
    setPlaceDetails("Проверьте соединение или попробуйте позже.");
    return;
  }

  // Преобразуем элементы в список точек
  let places = data.elements
    .map((el) => {
      // Для node координаты lat/lon, для way/relation — center.lat/center.lon
      let lat = el.lat;
      let lon = el.lon;

      if (!lat || !lon) {
        if (el.center && el.center.lat && el.center.lon) {
          lat = el.center.lat;
          lon = el.center.lon;
        }
      }

      if (!lat || !lon) return null;

      const tags = el.tags || {};
      const name = tags.name || tags["name:en"] || "";

      if (onlyName && !name) {
        // Отбрасываем "безымянные" объекты, если включен фильтр
        return null;
      }

      // Простая классификация типа по amenity
      const amenity = tags.amenity || "";

      return {
        id: el.id,
        type: el.type,
        lat,
        lon,
        name,
        amenity,
        tags
      };
    })
    .filter(Boolean);

  if (!places.length) {
    setStatus(
      "В радиусе " + radius + " м не найдено подходящих заведений.",
      true
    );
    setPlaceDetails(
      "Попробуйте увеличить радиус, изменить тип заведения или отключить фильтр по названию."
    );
    return;
  }

  // Считаем расстояния и находим ближайшее
  places = places.map((p) => {
    const distanceKm = haversineDistance(
      { lat: userLocation.lat, lng: userLocation.lng },
      { lat: p.lat, lng: p.lon }
    );
    return { ...p, distanceKm };
  });

  places.sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = places[0];

  // Маркеры всех найденных
  places.forEach((p) => {
    const marker = L.marker([p.lat, p.lon], {
      title: p.name || p.amenity || "Заведение общепита"
    }).addTo(map);

    const label =
      (p.name || "Заведение общепита") +
      (p.amenity ? ` (${p.amenity})` : "");

    marker.bindPopup(
      `<div style="font-size:13px;">
        <strong>${escapeHtml(label)}</strong><br/>
        Расстояние: ${formatDistance(p.distanceKm)}
      </div>`
    );

    renderObjects.push(marker);
  });

  // Выделяем ближайшее: зелёный маркер + линия
  highlightNearest(userLocation, nearest);

  setStatus(
    "Найдено заведений: " +
      places.length +
      ". Ближайшее выделено зелёным маркером.",
    false
  );
}

// Подсветка ближайшего заведения
function highlightNearest(userLocation, nearest) {
  if (!nearest) return;

  const nearestLatLng = [nearest.lat, nearest.lon];

  // Зеленый маркер
  const nearestMarker = L.marker(nearestLatLng, {
    title: (nearest.name || "Ближайшее заведение") + " (ближайшее)",
    icon: L.icon({
      iconUrl: "https://maps.google.com/mapfiles/ms/icons/green-dot.png",
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -28]
    })
  }).addTo(map);

  renderObjects.push(nearestMarker);

  // Линия от пользователя до заведения
  const line = L.polyline(
    [
      [userLocation.lat, userLocation.lng],
      [nearest.lat, nearest.lon]
    ],
    {
      color: "#388e3c",
      weight: 3,
      opacity: 0.9
    }
  ).addTo(map);

  renderObjects.push(line);

  // Подгоняем карту
  const bounds = L.latLngBounds(
    [userLocation.lat, userLocation.lng],
    nearestLatLng
  );
  map.fitBounds(bounds, { padding: [40, 40] });

  // Обновляем инфо-блок
  updatePlaceDetails(nearest);
}

// Обновить блок информации о ближайшем заведении
function updatePlaceDetails(place) {
  if (!place) {
    setPlaceDetails("Не удалось определить ближайшее заведение.");
    return;
  }

  const distanceStr = formatDistance(place.distanceKm);

  const name = place.name || "Без названия";
  const amenity = place.amenity || "общепит";

  const tags = place.tags || {};
  const cuisine = tags.cuisine ? `Кухня: ${tags.cuisine}` : "";
  const addrParts = [
    tags["addr:street"],
    tags["addr:housenumber"],
    tags["addr:city"],
    tags["addr:suburb"]
  ].filter(Boolean);
  const address = addrParts.join(", ");

  const openingHours = tags.opening_hours
    ? `Часы работы: ${tags.opening_hours}`
    : "";

  const website = tags.website || tags["contact:website"] || "";
  const phone =
    tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "";

  const osmUrl = `https://www.openstreetmap.org/${place.type}/${place.id}`;

  const html = `
    <div class="place-name">${escapeHtml(name)}</div>
    <div class="place-address">${
      address ? escapeHtml(address) : "Адрес по OSM не указан"
    }</div>
    <div class="place-meta place-distance">Расстояние: ${distanceStr}</div>
    <div class="place-meta">Тип: ${escapeHtml(amenity)}</div>
    ${cuisine ? `<div class="place-meta">${escapeHtml(cuisine)}</div>` : ""}
    ${
      openingHours
        ? `<div class="place-meta">${escapeHtml(openingHours)}</div>`
        : ""
    }
    ${
      phone
        ? `<div class="place-meta">Телефон: ${escapeHtml(phone)}</div>`
        : ""
    }
    ${
      website
        ? `<div class="place-meta"><a href="${escapeAttr(
            website
          )}" target="_blank" rel="noopener noreferrer">Сайт</a></div>`
        : ""
    }
    <div class="place-tags">
      Данные из OpenStreetMap — могут быть неточными. 
      <a href="${osmUrl}" target="_blank" rel="noopener noreferrer">Посмотреть объект в OSM</a>
    </div>
  `;

  setPlaceDetails(html);
}

// Вспомогательные функции

function setStatus(msg, isError = false) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = msg || "";
  statusEl.classList.remove("status-error", "status-ok");
  statusEl.classList.add(isError ? "status-error" : "status-ok");
}

function setPlaceDetails(html) {
  document.getElementById("placeDetails").innerHTML = html;
}

function clearRenderObjects() {
  renderObjects.forEach((obj) => {
    if (obj && typeof obj.remove === "function") {
      obj.remove();
    }
  });
  renderObjects = [];
}

// Расстояние (Haversine), результат в км
function haversineDistance(a, b) {
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLng = deg2rad(b.lng - a.lng);
  const lat1 = deg2rad(a.lat);
  const lat2 = deg2rad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const c =
    2 *
    Math.asin(
      Math.sqrt(
        sinDLat * sinDLat +
          Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng
      )
    );
  return R * c;
}

function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

function formatDistance(km) {
  const meters = Math.round(km * 1000);
  if (meters < 1000) return meters + " м";
  return (meters / 1000).toFixed(2) + " км";
}

// Простейшая экранизация для HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Регистрация Service Worker
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("service-worker.js")
        .then((reg) => {
          console.log("Service Worker зарегистрирован:", reg.scope);
        })
        .catch((err) => {
          console.warn("Ошибка регистрации Service Worker:", err);
        });
    });
  }
}
