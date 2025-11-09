// Глобальные переменные
let map;
let userMarker = null;
let placesService = null;
let renderObjects = []; // маркеры/линии ближайших
let currentNearest = null;

// Инициализация приложения: вызывается как callback=initApp в скрипте Google Maps
window.initApp = function () {
  initMap();
  initUI();
  registerServiceWorker();
};

// Инициализация карты
function initMap() {
  const defaultCenter = { lat: 55.7558, lng: 37.6173 }; // Москва по умолчанию

  map = new google.maps.Map(document.getElementById("map"), {
    center: defaultCenter,
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
  });

  placesService = new google.maps.places.PlacesService(map);
}

// Инициализация UI
function initUI() {
  const findBtn = document.getElementById("findBtn");
  findBtn.addEventListener("click", onFindClick);
}

// Обработчик кнопки "Найти ближайшее заведение"
function onFindClick() {
  if (!navigator.geolocation) {
    setStatus("Геолокация не поддерживается вашим браузером.", true);
    return;
  }

  // Считываем параметры
  const type = document.getElementById("placeType").value;
  let radius = parseInt(document.getElementById("radius").value, 10);
  const openNow = document.getElementById("openNow").checked;

  if (isNaN(radius) || radius < 100) radius = 100;
  if (radius > 5000) radius = 5000;

  setStatus("Определяем ваше местоположение...");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const userLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };

      showUserLocation(userLocation);
      setStatus("Местоположение определено. Ищем заведения поблизости...");

      searchNearestPlace({
        userLocation,
        type,
        radius,
        openNow,
      });
    },
    (err) => {
      console.error(err);
      if (err.code === err.PERMISSION_DENIED) {
        setStatus("Доступ к геолокации запрещен. Разрешите доступ и попробуйте снова.", true);
      } else {
        setStatus("Не удалось получить геолокацию. Повторите попытку.", true);
      }
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    }
  );
}

// Отображение местоположения пользователя
function showUserLocation(location) {
  if (userMarker) {
    userMarker.setMap(null);
  }

  userMarker = new google.maps.Marker({
    position: location,
    map,
    title: "Вы здесь",
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#1976d2",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2,
    },
  });

  map.setCenter(location);
  map.setZoom(15);
}

// Поиск ближайшего заведения по параметрам
function searchNearestPlace({ userLocation, type, radius, openNow }) {
  if (!placesService) {
    setStatus("Сервис Google Places не инициализирован.", true);
    return;
  }

  clearRenderObjects();
  currentNearest = null;

  const request = {
    location: userLocation,
    radius: radius,
    type: [type],
  };

  if (openNow) {
    request.openNow = true;
  }

  placesService.nearbySearch(request, (results, status) => {
    if (
      status !== google.maps.places.PlacesServiceStatus.OK ||
      !results ||
      results.length === 0
    ) {
      console.warn("Nearby search status:", status);
      const openFilterText = openNow ? " (только открытые сейчас)" : "";
      setStatus(
        "Не найдено заведений в радиусе " + radius + " м" + openFilterText + ".",
        true
      );
      setPlaceDetails(
        "Попробуйте увеличить радиус, изменить тип заведения или отключить фильтр по открытости."
      );
      return;
    }

    // Строим маркеры и находим ближайшее
    const enriched = results
      .filter((p) => p.geometry && p.geometry.location)
      .map((place) => {
        const placeLoc = {
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng(),
        };
        const distanceKm = haversineDistance(userLocation, placeLoc);
        return { place, distanceKm, placeLoc };
      });

    if (!enriched.length) {
      setStatus("Не удалось определить координаты найденных мест.", true);
      return;
    }

    // Маркеры всех найденных
    enriched.forEach(({ place, placeLoc }) => {
      const marker = new google.maps.Marker({
        map,
        position: placeLoc,
        title: place.name,
        icon: {
          url: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
        },
      });

      const content = `
        <div style="font-size:13px;">
          <strong>${place.name || "Заведение"}</strong><br />
          ${(place.vicinity || place.formatted_address || "")}
        </div>
      `;
      const infowindow = new google.maps.InfoWindow({ content });

      marker.addListener("click", () => {
        infowindow.open(map, marker);
      });

      renderObjects.push(marker);
    });

    // Нахождение ближайшего
    enriched.sort((a, b) => a.distanceKm - b.distanceKm);
    currentNearest = enriched[0];

    highlightNearest(userLocation, currentNearest);

    setStatus(
      "Найдено заведений: " +
        enriched.length +
        ". Ближайшее выделено зелёным маркером.",
      false
    );
  });
}

// Подсветка ближайшего заведения, линия, инфо
function highlightNearest(userLocation, nearestData) {
  if (!nearestData) return;

  const { place, distanceKm, placeLoc } = nearestData;
  const distanceM = Math.round(distanceKm * 1000);

  // Зеленый маркер для ближайшего заведения
  const nearestMarker = new google.maps.Marker({
    map,
    position: placeLoc,
    title: (place.name || "Ближайшее заведение") + " (ближайшее)",
    icon: {
      url: "https://maps.google.com/mapfiles/ms/icons/green-dot.png",
    },
    zIndex: 999,
  });
  renderObjects.push(nearestMarker);

  // Линия от пользователя до заведения
  const line = new google.maps.Polyline({
    path: [userLocation, placeLoc],
    geodesic: true,
    strokeColor: "#388e3c",
    strokeOpacity: 0.9,
    strokeWeight: 3,
    map,
  });
  renderObjects.push(line);

  // Подгоняем границы карты
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(userLocation);
  bounds.extend(placeLoc);
  map.fitBounds(bounds);

  // Подробности: отдельно запросим детали
  placesService.getDetails(
    {
      placeId: place.place_id,
      fields: [
        "name",
        "vicinity",
        "formatted_address",
        "rating",
        "user_ratings_total",
        "opening_hours",
        "website",
        "formatted_phone_number",
        "geometry",
      ],
    },
    (details, status) => {
      let infoPlace = place;
      if (
        status === google.maps.places.PlacesServiceStatus.OK &&
        details
      ) {
        infoPlace = { ...place, ...details };
      }
      updatePlaceDetails(infoPlace, distanceM);
    }
  );
}

// Обновление блока результата
function updatePlaceDetails(place, distanceM) {
  if (!place) {
    setPlaceDetails("Не удалось получить данные о заведении.");
    return;
  }

  const name = place.name || "Заведение";
  const address =
    place.formatted_address || place.vicinity || "Адрес не указан";
  const rating = place.rating
    ? place.rating.toFixed(1) + " ★ (" + (place.user_ratings_total || 0) + " отзывов)"
    : "Рейтинг неизвестен";

  const distanceStr =
    distanceM < 1000
      ? distanceM + " м"
      : (distanceM / 1000).toFixed(2) + " км";

  let openStatusHtml = "";
  if (place.opening_hours && typeof place.opening_hours.isOpen === "function") {
    const openNow = place.opening_hours.isOpen();
    openStatusHtml = `<div class="place-open ${
      openNow ? "open" : "closed"
    }">${openNow ? "Сейчас открыто" : "Сейчас закрыто"}</div>`;
  }

  const phone = place.formatted_phone_number
    ? `<div class="place-meta">Телефон: ${place.formatted_phone_number}</div>`
    : "";

  const website = place.website
    ? `<div class="place-link"><a href="${place.website}" target="_blank" rel="noopener noreferrer">Сайт заведения</a></div>`
    : "";

  const mapsLink = place.place_id
    ? `<div class="place-link">
         <a href="https://www.google.com/maps/place/?q=place_id:${place.place_id}"
            target="_blank" rel="noopener noreferrer">Открыть в Google Картах</a>
       </div>`
    : "";

  const html = `
    <div class="place-name">${name}</div>
    <div class="place-address">${address}</div>
    <div class="place-meta">Расстояние: ${distanceStr}</div>
    <div class="place-rating">Рейтинг: ${rating}</div>
    ${openStatusHtml}
    ${phone}
    ${website}
    ${mapsLink}
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
    if (obj && typeof obj.setMap === "function") {
      obj.setMap(null);
    }
  });
  renderObjects = [];
}

// Haversine: расстояние в км
function haversineDistance(a, b) {
  const R = 6371; // км
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
